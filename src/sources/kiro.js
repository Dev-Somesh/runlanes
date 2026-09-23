/**
 * Kiro IDE source.
 *
 * Reads workspace-sessions under the IDE's globalStorage (not ~/.kiro, which
 * is config). Token usage is billed in credits, not tokens, so runs report
 * unmeasured rather than a guessed count. Kiro CLI's sqlite store is not
 * read — that would need a native dependency this package does not take.
 *
 * Everything vendor-specific lives here. The rest of runlanes only sees
 * the normalised types.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusFromLastWrite, orderFileEvents } from "./types.js";
import { repoRelative, filesFromCommand, sameProject, walkFiles, listMarkdown } from "./read.js";

function defaultRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Kiro", "User", "globalStorage", "kiro.kiroagent");
  }
  return path.join(os.homedir(), ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
}

const ROOT = defaultRoot();
const WRITE_ACTIONS = new Set(["write", "create", "replace", "delete", "append"]);
const cache = new Map();
const execIndex = new Map(); // root -> { mtime, bySession }

function encodeWorkspace(cwd) {
  return Buffer.from(path.resolve(cwd)).toString("base64").replace(/=+$/, "");
}

function msIso(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!n || Number.isNaN(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function workspaceFolder(cwd, root) {
  const base = path.join(root, "workspace-sessions");
  const direct = path.join(base, encodeWorkspace(cwd));
  if (fs.existsSync(direct)) return direct;
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = path.join(base, name);
    const index = readJson(path.join(dir, "sessions.json"));
    const rows = Array.isArray(index) ? index : [];
    if (rows.some((r) => sameProject(cwd, r.workspaceDirectory || r.workspacePath))) {
      return dir;
    }
    // A folder with session files but no index still counts if one of them
    // names this project.
    try {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "sessions.json")) {
        const data = readJson(path.join(dir, f));
        if (sameProject(cwd, data?.workspaceDirectory || data?.workspacePath)) return dir;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function kiroPath(raw, repoRoot) {
  if (typeof raw !== "string" || !raw) return null;
  return repoRelative(repoRoot, raw.replace(/^file:\/\//, ""));
}

function filesFromAction(action, repoRoot) {
  const reads = new Set();
  const writes = new Set();
  const type = action?.actionType;
  const input = action?.input || {};
  if (type === "readFiles" && Array.isArray(input.files)) {
    for (const f of input.files) {
      const rel = kiroPath(f?.path || f?.file, repoRoot);
      if (rel) reads.add(rel);
    }
  }
  if (WRITE_ACTIONS.has(type)) {
    const rel = kiroPath(input.file || input.path, repoRoot);
    if (rel) writes.add(rel);
  }
  if (type === "runCommand") {
    for (const f of filesFromCommand(input.command, repoRoot)) reads.add(f);
  }
  return { reads, writes };
}

function dirMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Execution files are hashed names under profile directories. Index them by
 * chatSessionId once per root, invalidated when the root's mtime moves.
 */
function executionsBySession(root) {
  const mtime = dirMtime(root);
  const hit = execIndex.get(root);
  if (hit && hit.mtime === mtime) return hit.bySession;

  const bySession = new Map();
  const skip = new Set(["workspace-sessions", "dev_data", "index"]);
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    execIndex.set(root, { mtime, bySession });
    return bySession;
  }
  for (const ent of names) {
    if (!ent.isDirectory() || skip.has(ent.name) || ent.name.startsWith(".")) continue;
    const files = walkFiles(path.join(root, ent.name), (name, full) => {
      if (name.includes(".")) return false;
      try {
        return fs.statSync(full).size < 2_000_000;
      } catch {
        return false;
      }
    });
    for (const file of files) {
      const data = readJson(file);
      if (!data || !data.executionId || !data.chatSessionId) continue;
      const list = bySession.get(data.chatSessionId) || [];
      list.push(data);
      bySession.set(data.chatSessionId, list);
    }
  }
  execIndex.set(root, { mtime, bySession });
  return bySession;
}

function parseSession(file, repoRoot, executions) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  const execStamp = (executions || []).map((e) => `${e.executionId}:${e.endTime || ""}`).join(",");
  if (hit && hit.mtime === mtime && hit.execStamp === execStamp) return hit.value;

  const data = readJson(file);
  if (!data || !data.sessionId) {
    cache.set(file, { mtime, execStamp, value: null });
    return null;
  }

  const history = Array.isArray(data.history) ? data.history : [];
  const reads = new Set();
  const writes = new Set();
  const events = [];
  let toolCalls = 0;
  let turns = 0;
  let first = msIso(data.dateCreated);
  let last = new Date(mtime).toISOString();

  for (const entry of history) {
    const role = entry?.message?.role;
    if (role === "assistant") turns++;
    if (role === "user") {
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.map((b) => b?.text || "").join("\n")
        : String(content || "");
      if (!first && text) first = last;
    }
  }

  for (const exec of executions || []) {
    const start = msIso(exec.startTime);
    const end = msIso(exec.endTime);
    if (start) first = first && start > first ? first : start;
    if (end) last = end > last ? end : last;
    for (const action of exec.actions || []) {
      if (action.actionType === "model" || action.actionType === "say") continue;
      if (action.actionType && action.actionType !== "intentClassification") toolCalls++;
      const files = filesFromAction(action, repoRoot);
      // Kiro times the execution, not the actions inside it. Stamping every
      // action with the execution's start would read as a measurement of when
      // the write happened, which it is not.
      for (const f of files.reads) {
        reads.add(f);
        events.push({ path: f, kind: "read", at: null });
      }
      for (const f of files.writes) {
        writes.add(f);
        events.push({ path: f, kind: "write", at: null });
      }
    }
  }

  for (const w of writes) reads.delete(w);
  first = first || last;
  const model = data.selectedModel && data.selectedModel !== "auto" ? data.selectedModel : data.defaultModelTitle || null;

  const value = {
    id: data.sessionId,
    name: (data.title || "(unnamed)").slice(0, 80),
    kind: data.sessionType || null,
    model: model && model !== "Agent" ? model : null,
    effort: null,
    status: statusFromLastWrite(last),
    usageRecorded: false,
    tokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    toolCalls,
    turns,
    startedAt: first,
    lastActivityAt: last,
    durationMs: first && last ? new Date(last) - new Date(first) : null,
    reads: [...reads].sort(),
    fileEvents: orderFileEvents(events),
    writes: [...writes].sort(),
    depth: 0,
  };
  cache.set(file, { mtime, execStamp, value });
  return value;
}

export const kiro = {
  id: "kiro",
  label: "Kiro",

  detect() {
    return fs.existsSync(ROOT) || fs.existsSync(path.join(os.homedir(), ".kiro"));
  },

  sessions({ cwd, root = ROOT }) {
    const dir = workspaceFolder(cwd, root);
    if (!dir) return [];

    let files;
    try {
      files = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "sessions.json");
    } catch {
      return [];
    }

    const execs = executionsBySession(root);
    const out = [];
    for (const name of files) {
      const file = path.join(dir, name);
      const preview = readJson(file);
      if (preview?.workspaceDirectory && !sameProject(cwd, preview.workspaceDirectory)) continue;
      const run = parseSession(file, cwd, execs.get(preview?.sessionId || name.replace(/\.json$/, "")) || []);
      if (!run) continue;
      out.push({
        id: run.id,
        sourceId: "kiro",
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
        runs: [run],
        totals: {
          usageRecorded: false,
          tokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
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

kiro.documents = function documents({ cwd }) {
  const out = [];
  const base = path.join(cwd, ".kiro");
  for (const kind of [
    { id: "steering", label: "Steering" },
    { id: "specs", label: "Specs" },
    { id: "agents", label: "Agents" },
    { id: "skills", label: "Skills" },
  ]) {
    const items = listMarkdown(path.join(base, kind.id), { cwd, scope: "project", kind: kind.id });
    if (!items) continue;
    out.push({ id: `project-${kind.id}`, label: `${kind.label} (project)`, scope: "project", items });
  }
  return out;
};
