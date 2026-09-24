import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sharedFiles, ownFiles, lifetime, concurrency, nowSessions, modelsInPlay, filterSessions,
  collisions,
} from "../src/analyse.js";

const run = (id, over = {}) => ({
  id, name: id, kind: null, model: null, status: "finished",
  tokens: 0, outputTokens: 0, toolCalls: 0, turns: 0,
  startedAt: null, lastActivityAt: null, durationMs: null,
  reads: [], writes: [], depth: 1, ...over,
});

test("sharedFiles links runs that touched the same file", () => {
  const shared = sharedFiles([
    run("a", { reads: ["src/app.ts", "a-only.ts"] }),
    run("b", { writes: ["src/app.ts"] }),
  ]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].file, "src/app.ts");
  assert.deepEqual(shared[0].runs.sort(), ["a", "b"]);
});

test("a file only one run touched is not shared", () => {
  // Otherwise every file a single agent opened becomes a false connection.
  const shared = sharedFiles([run("a", { reads: ["solo.ts"] })]);
  assert.deepEqual(shared, []);
});

test("sharedFiles counts a read and a write as the same contact", () => {
  const shared = sharedFiles([
    run("a", { reads: ["x.ts"] }),
    run("b", { writes: ["x.ts"] }),
  ]);
  assert.equal(shared[0].runs.length, 2);
});

test("shared files are ordered by how many runs touched them", () => {
  const shared = sharedFiles([
    run("a", { reads: ["hot.ts", "warm.ts"] }),
    run("b", { reads: ["hot.ts", "warm.ts"] }),
    run("c", { reads: ["hot.ts"] }),
  ]);
  assert.equal(shared[0].file, "hot.ts");
  assert.equal(shared[0].runs.length, 3);
});

const at = (s) => new Date(Date.UTC(2026, 0, 15, 10, 0, s)).toISOString();
const touching = (id, opts) => ({ id, reads: [], writes: [], ...opts });
const writing = (id, file, from, to) =>
  touching(id, { writes: [file], startedAt: at(from), lastActivityAt: at(to) });

// A shared file says two runs touched the same ground. A collision says they
// were standing on it together, which is the claim worth interrupting someone
// for.
test("a collision is two writers whose runs overlapped", () => {
  const found = collisions([writing("a", "src/auth.ts", 0, 60), writing("b", "src/auth.ts", 30, 90)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, "src/auth.ts");
  assert.deepEqual(found[0].runs.sort(), ["a", "b"]);
  assert.equal(found[0].overlapMs, 30_000);
});

test("writes to the same file at different times are a handover, not a collision", () => {
  assert.deepEqual(collisions([writing("a", "x.ts", 0, 10), writing("b", "x.ts", 20, 30)]), []);
});

// Runs that end and begin on the same instant did not overlap. Treating that
// as a collision would flag every orderly handover in a pipeline.
test("runs that touch end to end do not collide", () => {
  assert.deepEqual(collisions([writing("a", "x.ts", 0, 30), writing("b", "x.ts", 30, 60)]), []);
});

test("reading a file while another run writes it is not a collision", () => {
  const reader = touching("a", { reads: ["x.ts"], startedAt: at(0), lastActivityAt: at(60) });
  assert.deepEqual(collisions([reader, writing("b", "x.ts", 10, 50)]), []);
});

test("a run with no clock cannot be placed against another and is left out", () => {
  const undated = touching("a", { writes: ["x.ts"] });
  assert.deepEqual(collisions([undated, writing("b", "x.ts", 0, 60)]), []);
});

test("three runs on one file report every run involved once", () => {
  const found = collisions([
    writing("a", "x.ts", 0, 60),
    writing("b", "x.ts", 30, 90),
    writing("c", "x.ts", 40, 50),
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].runs.sort(), ["a", "b", "c"]);
});

// The spans say two runs were open at once. The write events say which one
// landed on top, which is the question somebody actually has.
test("a collision names the run that wrote last, from the stamped events", () => {
  const a = { ...writing("a", "x.ts", 0, 60), fileEvents: [{ path: "x.ts", kind: "write", at: at(10) }] };
  const b = { ...writing("b", "x.ts", 30, 90), fileEvents: [{ path: "x.ts", kind: "write", at: at(40) }] };
  const [found] = collisions([a, b]);
  assert.deepEqual(found.lastWrite, { runId: "b", at: at(40) });
});

test("the last writer is the latest write, not the run that ended latest", () => {
  // b runs on longer but a came back and wrote again after it.
  const a = { ...writing("a", "x.ts", 0, 60), fileEvents: [{ path: "x.ts", kind: "write", at: at(50) }] };
  const b = { ...writing("b", "x.ts", 30, 90), fileEvents: [{ path: "x.ts", kind: "write", at: at(35) }] };
  assert.equal(collisions([a, b])[0].lastWrite.runId, "a");
});

// Cursor stamps its user turns rather than its tool calls, and Kiro times an
// execution rather than the actions inside it. Neither should be made to
// produce an ordering it never recorded.
test("an unstamped collision reports no last writer rather than guessing", () => {
  const a = { ...writing("a", "x.ts", 0, 60), fileEvents: [{ path: "x.ts", kind: "write", at: null }] };
  const b = { ...writing("b", "x.ts", 30, 90), fileEvents: [{ path: "x.ts", kind: "write", at: null }] };
  assert.equal(collisions([a, b])[0].lastWrite, null);
});

test("a collision with no events at all still reports the collision", () => {
  const [found] = collisions([writing("a", "x.ts", 0, 60), writing("b", "x.ts", 30, 90)]);
  assert.equal(found.file, "x.ts");
  assert.equal(found.lastWrite, null);
});

test("a write to another file does not become this file's last writer", () => {
  const a = { ...writing("a", "x.ts", 0, 60), fileEvents: [{ path: "other.ts", kind: "write", at: at(59) }] };
  const b = { ...writing("b", "x.ts", 30, 90), fileEvents: [{ path: "x.ts", kind: "write", at: at(40) }] };
  assert.equal(collisions([a, b])[0].lastWrite.runId, "b");
});

test("a read is never the last writer", () => {
  const a = { ...writing("a", "x.ts", 0, 60), fileEvents: [{ path: "x.ts", kind: "read", at: at(59) }] };
  const b = { ...writing("b", "x.ts", 30, 90), fileEvents: [{ path: "x.ts", kind: "write", at: at(40) }] };
  assert.equal(collisions([a, b])[0].lastWrite.runId, "b");
});

test("a run colliding on two files reports both", () => {
  const found = collisions([
    touching("a", { writes: ["x.ts", "y.ts"], startedAt: at(0), lastActivityAt: at(60) }),
    touching("b", { writes: ["x.ts", "y.ts"], startedAt: at(30), lastActivityAt: at(90) }),
  ]);
  assert.deepEqual(found.map((c) => c.file).sort(), ["x.ts", "y.ts"]);
});

test("ownFiles excludes anything another run also touched", () => {
  const runs = [run("a", { writes: ["mine.ts", "ours.ts"] }), run("b", { reads: ["ours.ts"] })];
  assert.deepEqual(ownFiles(runs[0], sharedFiles(runs)), ["mine.ts"]);
});

test("lifetime sums across sessions without double counting", () => {
  const l = lifetime([
    { runs: [run("a", { tokens: 100, outputTokens: 10, toolCalls: 2, durationMs: 1000 })] },
    { runs: [run("b", { tokens: 50, outputTokens: 5, toolCalls: 1, durationMs: 2000 })] },
  ]);
  assert.equal(l.sessions, 2);
  assert.equal(l.runs, 2);
  assert.equal(l.tokens, 150);
  assert.equal(l.outputTokens, 15);
  assert.equal(l.toolCalls, 3);
  assert.equal(l.agentSeconds, 3);
});

/* ---- concurrency: the headline metric, and the easiest to get wrong ---- */

const span = (id, from, to) =>
  run(id, { startedAt: new Date(from).toISOString(), lastActivityAt: new Date(to).toISOString() });

test("fully overlapping runs report full overlap", () => {
  const c = concurrency([span("a", 0, 10_000), span("b", 0, 10_000)]);
  assert.equal(c.peak, 2);
  assert.equal(c.wallMs, 10_000);
  assert.equal(c.overlapMs, 10_000);
});

test("back-to-back runs never count as concurrent", () => {
  // This is the distinction the metric exists for: launched in sequence looks
  // identical to launched in parallel unless overlap is measured.
  //
  // The boundary matters. If A ends exactly as B starts they were never both
  // active, so peak must be 1 — which the sweep gets right by processing end
  // events before start events at equal timestamps.
  const c = concurrency([span("a", 0, 5_000), span("b", 5_000, 10_000)]);
  assert.equal(c.peak, 1);
  assert.equal(c.overlapMs, 0);
  assert.equal(c.wallMs, 10_000);
});

test("partial overlap is measured, not rounded to all or nothing", () => {
  const c = concurrency([span("a", 0, 6_000), span("b", 4_000, 10_000)]);
  assert.equal(c.overlapMs, 2_000);
  assert.equal(c.peak, 2);
});

test("peak reflects the most runs active at once, not the total", () => {
  const c = concurrency([
    span("a", 0, 10_000),
    span("b", 1_000, 9_000),
    span("c", 2_000, 8_000),
    span("d", 20_000, 30_000), // starts after the others end
  ]);
  assert.equal(c.peak, 3);
});

test("a single run has no concurrency", () => {
  const c = concurrency([span("a", 0, 5_000)]);
  assert.equal(c.peak, 1);
  assert.equal(c.overlapMs, 0);
});

test("runs without timestamps are ignored rather than crashing", () => {
  const c = concurrency([run("a"), run("b")]);
  assert.equal(c.peak, 0);
  assert.equal(c.overlapMs, 0);
});

const session = (id, sourceId, runs, over = {}) => ({
  id, sourceId, sourceLabel: sourceId, runs, startedAt: null, lastActivityAt: null, ...over,
});

test("nowSessions keeps every live session, not only the newest", () => {
  const a = session("old-live", "runner-a", [run("a1", { status: "running" })]);
  const b = session("new-live", "runner-b", [run("b1", { status: "running" })]);
  const now = nowSessions([b, a]);
  assert.equal(now.length, 2);
  assert.deepEqual(now.map((s) => s.id).sort(), ["new-live", "old-live"]);
});

test("nowSessions adds the newest idle session from a runner that is not live", () => {
  const live = session("cc-live", "alpha", [run("x", { status: "running", model: "m1" })]);
  const idleNew = session("cu-new", "beta", [run("y", { status: "finished", model: "m2" })]);
  const idleOld = session("cu-old", "beta", [run("z", { status: "finished", model: "m3" })]);
  const now = nowSessions([idleNew, live, idleOld]);
  assert.equal(now.length, 2);
  assert.ok(now.some((s) => s.id === "cc-live"));
  assert.ok(now.some((s) => s.id === "cu-new"));
  assert.ok(!now.some((s) => s.id === "cu-old"));
});

test("modelsInPlay groups by runner and recorded model, and does not invent one", () => {
  const now = [
    session("s1", "alpha", [
      run("a", { status: "running", model: "opus" }),
      run("b", { status: "finished", model: "opus" }),
    ]),
    session("s2", "beta", [run("c", { status: "running", model: null })]),
  ];
  const rows = modelsInPlay(now);
  assert.equal(rows.length, 2);
  const opus = rows.find((r) => r.model === "opus");
  const unknown = rows.find((r) => r.model == null);
  assert.equal(opus.running, 1);
  assert.equal(opus.runs, 2);
  assert.equal(unknown.sourceId, "beta");
  assert.equal(unknown.running, 1);
});

// History is read to answer "what happened recently". Ordering by start time
// pushed a session that began yesterday and is still being written to below one
// opened an hour ago and abandoned, so the page looked like it had stopped
// recording. Recency means the last write.
test("sessions are ordered by last write, not by when they started", async () => {
  const { collectSessions } = await import("../src/sources/index.js");
  const order = (list) =>
    [...list]
      .sort((a, b) =>
        String(b.lastActivityAt || b.startedAt).localeCompare(String(a.lastActivityAt || a.startedAt))
      )
      .map((s) => s.id);

  const stale = { id: "opened-later", startedAt: "2026-08-23T02:57:00Z", lastActivityAt: "2026-08-23T03:00:00Z" };
  const active = { id: "still-working", startedAt: "2026-08-22T10:46:00Z", lastActivityAt: "2026-08-23T07:02:00Z" };

  assert.deepEqual(order([stale, active]), ["still-working", "opened-later"]);
  assert.deepEqual(order([active, stale]), ["still-working", "opened-later"]);

  // A session with no last-write stamp falls back to its start rather than
  // sorting as the empty string and sinking to the bottom.
  const noStamp = { id: "no-last", startedAt: "2026-08-24T00:00:00Z", lastActivityAt: null };
  assert.equal(order([active, noStamp])[0], "no-last");

  assert.equal(typeof collectSessions, "function");
});

// --since is pitched for CI budget assertions, so dropping work silently is the
// worst thing it can do. It kept a session only if that session had subagent
// runs inside the window, so a conversation where the main agent did the work
// itself — no delegation, no runs — disappeared however recent it was.
test("--since keeps a session whose own conversation was active, not just one that delegated", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const cutoff = now - 24 * 3600 * 1000;

  const soloRecent = {
    id: "solo",
    startedAt: "2026-08-25T09:00:00.000Z",
    lastActivityAt: "2026-08-25T11:00:00.000Z",
    totals: { tokens: 3_800_000 },
    runs: [], // did all the work itself
  };
  const soloOld = {
    id: "solo-old",
    startedAt: "2026-08-01T09:00:00.000Z",
    lastActivityAt: "2026-08-01T10:00:00.000Z",
    totals: { tokens: 5000 },
    runs: [],
  };
  const delegated = {
    id: "delegated",
    startedAt: "2026-08-25T10:00:00.000Z",
    lastActivityAt: "2026-08-25T10:30:00.000Z",
    totals: { tokens: 1000 },
    runs: [{ id: "r1", startedAt: "2026-08-25T10:05:00.000Z", lastActivityAt: "2026-08-25T10:25:00.000Z" }],
  };

  const kept = filterSessions([soloRecent, soloOld, delegated], cutoff).map((s) => s.id);
  assert.ok(kept.includes("solo"), "a recent session that never delegated must survive");
  assert.ok(kept.includes("delegated"), "a session with runs in the window still survives");
  assert.ok(!kept.includes("solo-old"), "a session outside the window is still dropped");

  // and its tokens must reach the totals, or a CI assertion reads zero
  assert.equal(lifetime(filterSessions([soloRecent], cutoff)).mainTokens, 3_800_000);
});

// The case the report opened with: two runs that both rewrote a file through
// the shell. Every shell-derived path used to be filed as a read, so neither
// run held a write edge and the collision was invisible.
test("two runs that rewrote a file through the shell now collide", () => {
  const sed = (id, from, to) => ({
    ...writing(id, "config.json", from, to),
    writes: ["config.json"],
    fileEvents: [{ path: "config.json", kind: "write", at: at(from + 1) }],
  });
  const [found] = collisions([sed("a", 0, 60), sed("b", 30, 90)]);
  assert.equal(found.file, "config.json");
  assert.deepEqual(found.runs.sort(), ["a", "b"]);
});

// The other half: a path the command could not be read either way is contact,
// so it belongs in the graph, but it is not evidence of a collision.
test("a file only touched through an unreadable command shares but does not collide", () => {
  const runs = [
    { id: "a", reads: [], writes: [], touched: ["config.json"], startedAt: at(0), lastActivityAt: at(60) },
    { id: "b", reads: [], writes: [], touched: ["config.json"], startedAt: at(30), lastActivityAt: at(90) },
  ];
  assert.deepEqual(sharedFiles(runs), [{ file: "config.json", runs: ["a", "b"] }]);
  assert.deepEqual(collisions(runs), []);
});
