import { test } from "node:test";
import assert from "node:assert/strict";
import { consumedTokens, statusFromLastWrite, IDLE_MS, orderFileEvents } from "../src/sources/types.js";

test("consumedTokens is input + output + cache creation, never cache reads", () => {
  assert.equal(
    consumedTokens({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 5000,
    }),
    16
  );
});

test("consumedTokens treats missing usage as zero rather than crashing", () => {
  assert.equal(consumedTokens(null), 0);
  assert.equal(consumedTokens({}), 0);
});

test("a run quiet for longer than IDLE_MS is finished", () => {
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const recent = new Date(now - IDLE_MS + 1).toISOString();
  const old = new Date(now - IDLE_MS - 1).toISOString();
  assert.equal(statusFromLastWrite(recent, now), "running");
  assert.equal(statusFromLastWrite(old, now), "finished");
  assert.equal(statusFromLastWrite(null, now), "finished");
});

// Stamped events carry the order; unstamped ones keep the transcript's order
// behind them rather than claiming a position on the clock.
test("orderFileEvents sorts stamped events and parks unstamped ones last", () => {
  const out = orderFileEvents([
    { path: "b.ts", kind: "write", at: "2026-01-15T10:05:00.000Z" },
    { path: "c.ts", kind: "write", at: null },
    { path: "a.ts", kind: "read", at: "2026-01-15T10:00:00.000Z" },
  ]);
  assert.deepEqual(out.map((e) => e.path), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(out[2].at, null);
});

test("orderFileEvents drops repeats of the same touch and skips pathless entries", () => {
  const e = { path: "a.ts", kind: "read", at: "2026-01-15T10:00:00.000Z" };
  assert.equal(orderFileEvents([e, { ...e }, { kind: "read", at: null }]).length, 1);
});

test("a read and a write of one file at one moment are two events", () => {
  const at = "2026-01-15T10:00:00.000Z";
  assert.equal(orderFileEvents([{ path: "a.ts", kind: "read", at }, { path: "a.ts", kind: "write", at }]).length, 2);
});
