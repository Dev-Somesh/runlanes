/**
 * GitHub Copilot CLI source.
 *
 * Reads ~/.copilot/session-state/<sessionId>/events.jsonl. Copilot Chat in
 * VS Code does not write a transcript this tool can read; only the CLI does.
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
  listMarkdown,
} from "./read.js";

const HOME = process.env.COPILOT_HOME
  ? path.resolve(process.env.COPILOT_HOME)
  : path.join(os.homedir(), ".copilot");
const ROOT = path.join(HOME, "session-state");

const WRITE_TOOLS = new Set([
  "create",
  "write",
  "write_file",
  "str_replace",
  "edit",
  "replace",
  "edit_file",
  "apply_patch",
]);

const cache = new Map();

function iso(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function eventType(rec) {
  return rec.type || rec.event_type || "";
}

function num(obj, ...keys) {
  if (!obj || typeof obj !== "object") return 0;
  for (const k of keys) {
    if (typeof obj[k] === "number") return obj[k];
  }
  return 0;
}

function sessionCwd(file) {
  for (const rec of readJsonlHead(file)) {
    if (eventType(rec) !== "session.start") continue;
    const ctx = rec.data?.context || rec.data || {};
    return ctx.cwd || ctx.gitRoot || ctx.git_root || null;
  }
  return null;
}

function runName(records) {
  for (const rec of records) {
    if (eventType(rec) !== "user.message") continue;
    const text = rec.data?.content ?? rec.data?.message ?? rec.data?.text ?? "";
    const line = String(text).trim().split(/\n/)[0].replace(/\s+/g, " ");
    if (line) return line.slice(0, 80);
  }
  return "(unnamed)";
}

function toolName(data) {
  return data?.toolName || data?.tool_name || data?.name || "";
}

function toolArgs(data) {
  const raw = data?.arguments || data?.args || data?.input;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") return v;
    } catch {
      /* ignore */
    }
  }
  return {};
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

  const start = records.find((r) => eventType(r) === "session.start");
  const id =
    start?.data?.sessionId ||
    start?.data?.session_id ||
    path.basename(path.dirname(file));

  const reads = new Set();
  const writes = new Set();
  let model = null;
  let tokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  const events = [];
  const unsure = new Set();
  let first = null;
  let last = null;
  let sawShutdown = false;

  for (const rec of records) {
    const stamp = iso(rec.timestamp);
    if (stamp) {
      first = first || stamp;
      last = stamp;
    }
    const t = eventType(rec);
    const data = rec.data || {};
    if (t === "session.model_change") {
      model = data.newModel || data.new_model || model;
    }
    if (t === "assistant.turn_end" || t === "assistant.message") turns++;
    if (t === "tool.execution_start") {
      toolCalls++;
      const name = toolName(data);
      const args = toolArgs(data);
      const rel = repoRelative(repoRoot, args.path || args.file_path || args.filePath);
      const at = rec.timestamp || null;
      if (WRITE_TOOLS.has(name)) {
        if (rel) {
          writes.add(rel);
          events.push({ path: rel, kind: "write", at });
        }
      } else if (name === "bash" || name === "shell" || name === "execute") {
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
      } else if (rel) {
        reads.add(rel);
        events.push({ path: rel, kind: "read", at });
      }
    }
    if (t === "session.shutdown") {
      const metrics = data.modelMetrics || data.model_metrics || {};
      for (const [m, metric] of Object.entries(metrics)) {
        if (!model) model = m;
        const usage = metric.usage || metric;
        const input = num(usage, "inputTokens", "input_tokens");
        const output = num(usage, "outputTokens", "output_tokens");
        const reasoning = num(usage, "reasoningTokens", "reasoning_tokens");
        const cacheRead = num(usage, "cacheReadTokens", "cache_read_tokens");
        const cacheWrite = num(usage, "cacheWriteTokens", "cache_write_tokens");
        // Copilot's outputTokens already includes reasoning; don't count twice.
        const billedOutput = Math.max(0, output - reasoning);
        tokens += input + billedOutput + cacheWrite;
        outputTokens += billedOutput;
        cacheReadTokens += cacheRead;
        cacheWriteTokens += cacheWrite;
        sawShutdown = true;
      }
    }
  }

  for (const w of writes) reads.delete(w);
  for (const w of writes) unsure.delete(w);
  for (const r of reads) unsure.delete(r);
  last = last || new Date(mtime).toISOString();
  first = first || last;

  const value = {
    id,
    name: runName(records),
    kind: null,
    model,
    effort: null,
    status: statusFromLastWrite(last),
    usageRecorded: sawShutdown,
    tokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    toolCalls,
    turns,
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

export const copilot = {
  id: "copilot",
  label: "GitHub Copilot CLI",

  detect() {
    return fs.existsSync(ROOT) || fs.existsSync(HOME);
  },

  sessions({ cwd, root = ROOT }) {
    if (!fs.existsSync(root)) return [];
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }
    const out = [];
    for (const dir of dirs) {
      const file = path.join(root, dir.name, "events.jsonl");
      if (!fs.existsSync(file)) continue;
      if (!sameProject(cwd, sessionCwd(file))) continue;
      const run = parseRun(file, cwd);
      if (!run) continue;
      out.push({
        id: run.id,
        sourceId: "copilot",
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
          contextNow: 0,
          model: run.model,
        },
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  },
};

copilot.documents = function documents({ cwd }) {
  const out = [];
  const github = path.join(cwd, ".github");
  const kinds = [
    { dir: path.join(github, "instructions"), id: "instructions", label: "Instructions", ext: [".md"] },
    { dir: path.join(github, "agents"), id: "agents", label: "Agents" },
    { dir: path.join(github, "prompts"), id: "prompts", label: "Prompts" },
  ];
  for (const kind of kinds) {
    const items = listMarkdown(kind.dir, { cwd, scope: "project", kind: kind.id, ext: kind.ext || [".md"] });
    if (!items) continue;
    out.push({ id: `project-${kind.id}`, label: `${kind.label} (project)`, scope: "project", items });
  }
  const rootDocs = listMarkdown(github, { cwd, scope: "project", kind: "copilot-md" });
  const copilotMd = (rootDocs || []).filter((it) => /copilot-instructions/i.test(it.name));
  if (copilotMd.length) {
    out.push({
      id: "project-copilot-md",
      label: "Instructions (project)",
      scope: "project",
      items: copilotMd,
    });
  }
  return out;
};
