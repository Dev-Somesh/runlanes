/**
 * Codex source.
 *
 * Reads rollouts from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (or
 * $CODEX_HOME/sessions). Every project on the machine shares that tree, so a
 * session is kept only when session_meta.cwd is this project.
 *
 * Everything vendor-specific lives here. The rest of runlanes only sees
 * the normalised types.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusFromLastWrite, orderFileEvents } from "./types.js";
import {
  readJsonl,
  readJsonlHead,
  repoRelative,
  classifyCommand,
  sameProject,
  walkFiles,
  listMarkdown,
} from "./read.js";

const HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
const ROOT = path.join(HOME, "sessions");

const WRITE_TOOLS = new Set(["apply_patch", "write_file", "write"]);

const cache = new Map();

function iso(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function argsOf(pl) {
  const raw = pl?.arguments ?? pl?.input ?? pl?.params;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") return v;
    } catch {
      /* apply_patch stores the patch as a raw string */
    }
    return { input: raw };
  }
  return {};
}

function patchPaths(text, repoRoot) {
  const out = new Set();
  if (typeof text !== "string") return out;
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const rel = repoRelative(repoRoot, m[1].trim());
    if (rel) out.add(rel);
  }
  return out;
}

function runName(records) {
  for (const rec of records) {
    if (rec.type !== "event_msg") continue;
    const pl = rec.payload || {};
    if (pl.type !== "user_message") continue;
    const line = String(pl.message || "")
      .trim()
      .split(/\n/)[0]
      .replace(/\s+/g, " ");
    if (line) return line.slice(0, 80);
  }
  return "(unnamed)";
}

function parseRun(file, repoRoot) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const records = readJsonl(file);
  if (!records.length) {
    cache.set(file, { mtime, value: null });
    return null;
  }

  const meta = records.find((r) => r.type === "session_meta")?.payload || {};
  const id =
    meta.id ||
    path
      .basename(file)
      .replace(/^rollout-/, "")
      .replace(/\.jsonl$/, "");

  const reads = new Set();
  const writes = new Set();
  let model = null;
  let effort = null;
  let toolCalls = 0;
  let turns = 0;
  const events = [];
  const unsure = new Set();
  let first = iso(meta.timestamp) || iso(records[0]?.timestamp);
  let last = null;
  let usage = null;

  for (const rec of records) {
    const stamp = iso(rec.timestamp);
    if (stamp) {
      first = first || stamp;
      last = stamp;
    }
    const pl = rec.payload || {};
    if (rec.type === "turn_context") {
      model = model || pl.model || pl.collaboration_mode?.settings?.model || null;
      effort = effort || pl.collaboration_mode?.settings?.reasoning_effort || null;
    }
    if (rec.type === "event_msg" && pl.type === "token_count" && pl.info?.total_token_usage) {
      usage = pl.info.total_token_usage;
    }
    if (rec.type === "event_msg" && pl.type === "agent_message") turns++;
    if (rec.type === "response_item" && pl.type === "message" && pl.role === "assistant") turns++;

    if (rec.type === "response_item" && (pl.type === "function_call" || pl.type === "custom_tool_call")) {
      toolCalls++;
      const args = argsOf(pl);
      const name = pl.name || "";
      const at = rec.timestamp || null;
      if (WRITE_TOOLS.has(name) || name === "apply_patch") {
        for (const f of patchPaths(args.input || args.patch || "", repoRoot)) {
          writes.add(f);
          events.push({ path: f, kind: "write", at });
        }
        const rel = repoRelative(repoRoot, args.path || args.file_path || args.filePath);
        if (rel) {
          writes.add(rel);
          events.push({ path: rel, kind: "write", at });
        }
      } else {
        const rel = repoRelative(repoRoot, args.path || args.file_path || args.filePath);
        if (rel) {
          reads.add(rel);
          events.push({ path: rel, kind: "read", at });
        }
        const cmd = args.command || args.cmd;
        const sh = classifyCommand(cmd, repoRoot);
        for (const f of sh.writes) {
          writes.add(f);
          events.push({ path: f, kind: "write", at });
        }
        for (const f of sh.reads) {
          reads.add(f);
          events.push({ path: f, kind: "read", at });
        }
        for (const f of sh.unknown) {
          unsure.add(f);
          events.push({ path: f, kind: "touch", at });
        }
      }
    }
  }

  for (const w of writes) reads.delete(w);
  for (const w of writes) unsure.delete(w);
  for (const r of reads) unsure.delete(r);

  const input = usage?.input_tokens || 0;
  const cached = usage?.cached_input_tokens || 0;
  const output = usage?.output_tokens || 0;
  // Codex's input_tokens includes cached reads. Subtract them so the headline
  // matches Claude's: consumed, not "prompt re-reported every turn".
  const tokens = usage ? Math.max(0, input - cached) + output : 0;

  const value = {
    id,
    name: runName(records),
    kind: meta.source || meta.originator || null,
    model,
    effort,
    status: statusFromLastWrite(last),
    usageRecorded: !!usage,
    tokens,
    outputTokens: output,
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
    toolCalls,
    turns: turns || (usage ? 1 : 0),
    startedAt: first,
    lastActivityAt: last,
    durationMs: first && last ? new Date(last) - new Date(first) : null,
    reads: [...reads].sort(),
    touched: [...unsure].sort(),
    fileEvents: orderFileEvents(events),
    writes: [...writes].sort(),
    depth: 0,
  };
  cache.set(file, { mtime, value });
  return value;
}

function sessionCwd(file) {
  for (const rec of readJsonlHead(file)) {
    if (rec.type === "session_meta") return rec.payload?.cwd || null;
  }
  return null;
}

export const codex = {
  id: "codex",
  label: "Codex",

  detect() {
    return fs.existsSync(ROOT) || fs.existsSync(HOME);
  },

  sessions({ cwd, root = ROOT }) {
    if (!fs.existsSync(root)) return [];
    const files = walkFiles(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
    const out = [];
    for (const file of files) {
      if (!sameProject(cwd, sessionCwd(file))) continue;
      const run = parseRun(file, cwd);
      if (!run) continue;
      out.push({
        id: run.id,
        sourceId: "codex",
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
        runs: [run],
        totals: {
          usageRecorded: run.usageRecorded,
          tokens: run.tokens,
          outputTokens: run.outputTokens,
          cacheWriteTokens: run.cacheWriteTokens,
          cacheReadTokens: run.cacheReadTokens,
          toolCalls: run.toolCalls,
          turns: run.turns,
          contextNow: run.cacheReadTokens + Math.max(0, run.tokens - run.outputTokens),
          model: run.model,
        },
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  },
};

codex.documents = function documents({ cwd }) {
  const out = [];
  const kinds = [
    { dir: path.join(cwd, ".agents"), id: "agents", label: "Agents" },
    { dir: path.join(cwd, ".codex", "skills"), id: "skills", label: "Skills" },
    { dir: path.join(cwd, ".codex", "agents"), id: "codex-agents", label: "Agents" },
  ];
  for (const kind of kinds) {
    const items = listMarkdown(kind.dir, { cwd, scope: "project", kind: kind.id });
    if (!items) continue;
    out.push({ id: `project-${kind.id}`, label: `${kind.label} (project)`, scope: "project", items });
  }
  const agents = path.join(cwd, "AGENTS.md");
  try {
    const stat = fs.statSync(agents);
    out.push({
      id: "project-agents-md",
      label: "Agents (project)",
      scope: "project",
      items: [
        {
          id: "project:agents-md:AGENTS.md",
          name: "AGENTS",
          path: agents.replace(os.homedir(), "~"),
          rel: "AGENTS.md",
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          bytes: stat.size,
          markdown: fs.readFileSync(agents, "utf8"),
        },
      ],
    });
  } catch {
    /* no AGENTS.md */
  }
  return out;
};
