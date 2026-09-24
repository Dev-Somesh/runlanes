/**
 * Analysis over normalised sessions. No vendor knowledge lives here.
 */
import { estimateCostUsd, sumCostUsd } from "./prices.js";

/**
 * Files touched by more than one run in the same session.
 *
 * Interconnection is computed per session on purpose: two agents months apart
 * both reading a common config were not collaborating. Within one session,
 * touching the same file means working the same ground.
 */
export function sharedFiles(runs) {
  const touchedBy = new Map();
  for (const run of runs) {
    // A file touched through a shell command whose effect could not be
    // established is still contact, and belongs in the graph. It is only kept
    // out of `collisions`, which asks the stronger question.
    for (const file of [...run.reads, ...run.writes, ...(run.touched || [])]) {
      if (!touchedBy.has(file)) touchedBy.set(file, new Set());
      touchedBy.get(file).add(run.id);
    }
  }
  return [...touchedBy.entries()]
    .filter(([, who]) => who.size > 1)
    .map(([file, who]) => ({ file, runs: [...who] }))
    .sort((a, b) => b.runs.length - a.runs.length || a.file.localeCompare(b.file));
}

/**
 * Files two runs both wrote while both were running.
 *
 * `sharedFiles` reports contact, which is a weaker claim than it looks: two
 * runs reading the same config an hour apart share a file and were never in
 * each other's way. A collision is the stronger claim — both runs wrote, and
 * their spans overlapped, so neither was working from a settled file.
 *
 * What this does not claim is what landed. A transcript records that a write
 * was requested with a path, not the bytes before and after, so the honest
 * statement is that the runs were on the same ground at the same time. Which
 * edit survived is a question for git.
 */
export function collisions(runs) {
  const span = (r) =>
    r.startedAt && r.lastActivityAt ? [+new Date(r.startedAt), +new Date(r.lastActivityAt)] : null;

  const writers = new Map();
  for (const run of runs) {
    const at = span(run);
    if (!at) continue; // a run with no clock cannot be placed against another
    for (const file of run.writes || []) {
      if (!writers.has(file)) writers.set(file, []);
      writers.get(file).push({ id: run.id, at });
    }
  }

  const out = [];
  for (const [file, who] of writers) {
    if (who.length < 2) continue;
    const hit = new Set();
    let widest = 0;
    for (let i = 0; i < who.length; i++) {
      for (let j = i + 1; j < who.length; j++) {
        const overlap = Math.min(who[i].at[1], who[j].at[1]) - Math.max(who[i].at[0], who[j].at[0]);
        // Touching end to end is a handover, not a collision.
        if (overlap <= 0) continue;
        hit.add(who[i].id).add(who[j].id);
        widest = Math.max(widest, overlap);
      }
    }
    if (hit.size > 1) {
      // Who landed on top. The run spans say the two were open at once; the
      // write events say which one touched the file last, which is the thing
      // somebody actually wants when they open the graph. Runners that do not
      // stamp their tool calls contribute nothing here rather than a guess.
      let lastWrite = null;
      for (const run of runs) {
        if (!hit.has(run.id)) continue;
        for (const e of run.fileEvents || []) {
          if (e.kind !== "write" || e.path !== file || !e.at) continue;
          if (!lastWrite || e.at > lastWrite.at) lastWrite = { runId: run.id, at: e.at };
        }
      }
      out.push({ file, runs: [...hit], overlapMs: widest, lastWrite });
    }
  }

  return out.sort((a, b) => b.runs.length - a.runs.length || b.overlapMs - a.overlapMs || a.file.localeCompare(b.file));
}

/** Files only one run touched — that run's own territory. */
export function ownFiles(run, shared) {
  const sharedSet = new Set(shared.map((s) => s.file));
  return run.writes.filter((f) => !sharedSet.has(f));
}

/**
 * Totals across everything.
 *
 * Main-session work is counted separately from subagent runs and reported
 * both ways. Counting only subagents hid most of the activity in any
 * conversation where the main agent did the work itself — which is most of
 * them. Counting them together would hide the split.
 */
export function lifetime(sessions) {
  const runs = sessions.flatMap((s) => s.runs);
  const main = sessions.map((s) => s.totals || {});

  const sum = (list, key) => list.reduce((n, x) => n + (x[key] || 0), 0);

  // A runner that records no usage contributes 0, which would quietly pass as
  // "free" inside a total. Those are excluded and counted instead, so a
  // partial sum is visibly partial rather than silently wrong.
  const measured = (list) => list.filter((x) => x.usageRecorded !== false);
  const unmeasuredRuns = runs.length - measured(runs).length;

  const agentTokens = sum(measured(runs), "tokens");
  const mainTokens = sum(measured(main), "tokens");

  return {
    sessions: sessions.length,
    runs: runs.length,
    running: runs.filter((r) => r.status === "running").length,

    // Subagents only.
    tokens: agentTokens,
    outputTokens: sum(measured(runs), "outputTokens"),
    toolCalls: sum(runs, "toolCalls"),
    // How many runs the token figures above could not include.
    unmeasuredRuns,
    // Summed per run, so it exceeds wall-clock wherever runs overlapped.
    agentSeconds: Math.round(sum(runs, "durationMs") / 1000),
    costUsd: sumCostUsd(runs),

    // The conversation driving them.
    mainTokens,
    mainOutputTokens: sum(measured(main), "outputTokens"),
    mainToolCalls: sum(main, "toolCalls"),
    mainTurns: sum(main, "turns"),
    mainCostUsd: sumCostUsd(main),

    // Both together. Cost splits the same way the tokens do: reporting one
    // figure over split totals would understate spend by exactly the share
    // the main agent did itself.
    totalTokens: agentTokens + mainTokens,
    totalCostUsd: sumCostUsd([...runs, ...main]),
  };
}

/**
 * Parse `--since 1h` / `24h` / `7d` / `2026-08-01` into an epoch ms cutoff.
 * Invalid input returns null so the caller can reject it rather than
 * silently dropping the filter.
 */
export function parseSince(spec, now = Date.now()) {
  if (spec == null || spec === "") return null;
  const rel = String(spec).trim().match(/^(\d+)\s*([mhd])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase()];
    return now - n * unit;
  }
  const t = Date.parse(spec);
  return Number.isNaN(t) ? null : t;
}

/** Sessions with no run after the cutoff are dropped. */
export function filterSessions(sessions, sinceMs) {
  if (sinceMs == null) return sessions;

  const active = (x) => {
    const t = x && (x.lastActivityAt || x.startedAt);
    return !!t && +new Date(t) >= sinceMs;
  };

  return sessions
    .map((s) => ({ ...s, runs: s.runs.filter(active) }))
    // A session survives if its own conversation was active in the window, not
    // only if it delegated. Keying on runs alone dropped every session where
    // the main agent did the work itself — which is most of them — so --since
    // reported nothing for exactly the projects it was meant to measure.
    .filter((s) => s.runs.length || active(s));
}

/**
 * Link documents to runs from what was observed, not from what a prompt said.
 *
 * A run is connected to a document when:
 *   - it opened the file (path in reads/writes), or
 *   - the runner recorded the run as that agent type (kind ↔ agent definition).
 *
 * Kind is only matched against agent collections. A plan named "Explore" is
 * not the Explore agent.
 */
function namesMatch(a, b) {
  if (!a || !b) return false;
  const n = (s) => String(s).toLowerCase().replace(/[\s_]+/g, "-");
  return n(a) === n(b);
}

function fileMatch(rel, files) {
  if (!rel || typeof rel !== "string") return false;
  const want = rel.replace(/^\/+/, "");
  return files.some((f) => {
    const have = String(f).replace(/^\/+/, "");
    return have === want || have.endsWith("/" + want) || want.endsWith("/" + have);
  });
}

/**
 * Sessions with a run still writing. Different runners on the same project
 * show up as separate sessions — Now has to look at all of them, not just
 * the newest one.
 */
export function liveSessions(sessions) {
  return (sessions || []).filter((s) => (s.runs || []).some((r) => r.status === "running"));
}

/**
 * What Now should draw: every live session, plus the newest idle session
 * from any runner that is not already represented, so two runners on
 * different models appear together.
 */
export function nowSessions(sessions) {
  const list = sessions || [];
  const live = liveSessions(list);
  const seen = new Set(live.map((s) => s.sourceId));
  const extras = [];
  for (const s of list) {
    if (live.some((l) => l.id === s.id)) continue;
    if (seen.has(s.sourceId)) continue;
    extras.push(s);
    seen.add(s.sourceId);
  }
  const out = [...live, ...extras];
  if (out.length) return out;
  return list[0] ? [list[0]] : [];
}

/**
 * Runner × model currently in the Now set. A missing model stays null —
 * "not recorded" — rather than being guessed.
 */
export function modelsInPlay(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    for (const r of s.runs || []) {
      const model = r.model || s.totals?.model || null;
      const key = `${s.sourceId}\0${model || ""}`;
      if (!map.has(key)) {
        map.set(key, {
          sourceId: s.sourceId,
          sourceLabel: s.sourceLabel || s.sourceId,
          model,
          running: 0,
          runs: 0,
        });
      }
      const row = map.get(key);
      row.runs += 1;
      if (r.status === "running") row.running += 1;
    }
  }
  return [...map.values()].sort((a, b) => b.running - a.running || b.runs - a.runs);
}

export function linkDocs(runs, collections) {
  const byRun = new Map(runs.map((r) => [r.id, []]));
  const byDoc = new Map();
  for (const col of collections || []) {
    const isAgent = /(^|-)agents$/.test(col.id || "");
    for (const doc of col.items || []) {
      const who = [];
      for (const run of runs) {
        const files = [...(run.reads || []), ...(run.writes || [])];
        const opened = fileMatch(doc.rel, files);
        const typed = isAgent && namesMatch(run.kind, doc.name);
        if (!opened && !typed) continue;
        const via = opened ? "opened" : "kind";
        who.push({ id: run.id, name: run.name, kind: run.kind || null, via });
        byRun.get(run.id).push({
          id: doc.id,
          name: doc.name,
          collection: col.label,
          via,
        });
      }
      byDoc.set(doc.id, who);
    }
  }
  return { byRun, byDoc };
}

export { estimateCostUsd, sumCostUsd };

/**
 * How much of the elapsed time had more than one run active.
 *
 * This is the number that says whether parallelism actually happened, as
 * opposed to runs merely being launched together.
 */
export function concurrency(runs) {
  const spans = runs
    .filter((r) => r.startedAt && r.lastActivityAt)
    .map((r) => [+new Date(r.startedAt), +new Date(r.lastActivityAt)]);
  if (spans.length < 2) return { peak: spans.length, overlapMs: 0, wallMs: 0 };

  const events = [];
  for (const [start, end] of spans) {
    events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let active = 0;
  let peak = 0;
  let overlapMs = 0;
  let prev = events[0][0];
  for (const [at, delta] of events) {
    if (active > 1) overlapMs += at - prev;
    active += delta;
    peak = Math.max(peak, active);
    prev = at;
  }
  const wallMs = Math.max(...spans.map((s) => s[1])) - Math.min(...spans.map((s) => s[0]));
  return { peak, overlapMs, wallMs };
}
