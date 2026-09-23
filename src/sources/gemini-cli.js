/**
 * Gemini CLI source.
 *
 * Reads ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.jsonl (and older .json).
 * GEMINI_DIR / GEMINI_CONFIG_DIR relocate the whole tree.
 *
 * Everything vendor-specific lives here. The rest of runlanes only sees
 * the normalised types.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusFromLastWrite, orderFileEvents } from "./types.js";
import { readJsonl, repoRelative, filesFromCommand, listMarkdown } from "./read.js";

const HOME =
  process.env.GEMINI_DIR ||
  process.env.GEMINI_CONFIG_DIR ||
  path.join(os.homedir(), ".gemini");

const WRITE_TOOLS = new Set(["write_file", "replace", "edit", "WriteFile", "Edit"]);
const cache = new Map();

function projectHash(cwd) {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex");
}

function chatsDir(cwd, root) {
  return path.join(root, "tmp", projectHash(cwd), "chats");
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p?.text || ""))
    .filter(Boolean)
    .join("\n");
}

function iso(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function loadConversation(file) {
  if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  const records = readJsonl(file);
  if (!records.length) return null;
  const meta = {};
  const messages = [];
  for (const rec of records) {
    if (rec.$set || rec.$rewindTo) continue;
    if (rec.type === "user" || rec.type === "gemini" || rec.type === "info") {
      messages.push(rec);
    } else if (rec.sessionId) {
      Object.assign(meta, rec);
    }
  }
  return { ...meta, messages };
}

function filesFromArgs(args, repoRoot) {
  const out = new Set();
  if (!args || typeof args !== "object") return out;
  for (const key of ["file_path", "path", "absolute_path"]) {
    const rel = repoRelative(repoRoot, args[key]);
    if (rel) out.add(rel);
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      const rel = repoRelative(repoRoot, p);
      if (rel) out.add(rel);
    }
  }
  const cmd = args.command;
  for (const f of filesFromCommand(cmd, repoRoot)) out.add(f);
  return out;
}

function runName(messages) {
  for (const msg of messages) {
    if (msg.type !== "user") continue;
    const line = flattenContent(msg.content).trim().split(/\n/)[0].replace(/\s+/g, " ");
    if (line) return line.slice(0, 80);
  }
  return "(unnamed)";
}

function parseRun(file, repoRoot, { depth = 0, kind = null } = {}) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const conv = loadConversation(file);
  if (!conv) {
    cache.set(file, { mtime, value: null });
    return null;
  }
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const id =
    conv.sessionId ||
    path.basename(file).replace(/^session-/, "").replace(/\.(jsonl|json)$/, "");

  const reads = new Set();
  const writes = new Set();
  let model = null;
  let tokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  const events = [];
  let first = iso(conv.startTime);
  let last = iso(conv.lastUpdated);
  let contextNow = 0;
  let sawUsage = false;

  for (const msg of messages) {
    const stamp = iso(msg.timestamp);
    if (stamp) {
      first = first || stamp;
      last = stamp;
    }
    if (msg.model && !model) model = msg.model;
    if (msg.type === "gemini") turns++;
    const usage = msg.tokens;
    if (usage && typeof usage === "object") {
      sawUsage = true;
      const input = usage.input || 0;
      const cached = usage.cached || 0;
      const output = (usage.output || 0) + (usage.thoughts || 0);
      tokens += input + output + (usage.tool || 0);
      outputTokens += output;
      cacheReadTokens += cached;
      contextNow = input + cached;
    }
    const calls = msg.toolCalls || [];
    for (const call of calls) {
      toolCalls++;
      const target = WRITE_TOOLS.has(call.name) ? writes : reads;
      for (const f of filesFromArgs(call.args, repoRoot)) {
        target.add(f);
        events.push({ path: f, kind: target === writes ? "write" : "read", at: msg.timestamp || null });
      }
    }
  }

  for (const w of writes) reads.delete(w);
  last = last || new Date(mtime).toISOString();
  first = first || last;

  const value = {
    id,
    name: runName(messages),
    kind: kind || conv.kind || null,
    model,
    effort: null,
    status: statusFromLastWrite(last),
    usageRecorded: sawUsage,
    tokens,
    outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens,
    toolCalls,
    turns,
    startedAt: first,
    lastActivityAt: last,
    durationMs: first && last ? new Date(last) - new Date(first) : null,
    reads: [...reads].sort(),
    fileEvents: orderFileEvents(events),
    writes: [...writes].sort(),
    depth,
    contextNow,
  };
  cache.set(file, { mtime, value });
  return value;
}

function sessionFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("session-") && (n.endsWith(".jsonl") || n.endsWith(".json")))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export const geminiCli = {
  id: "gemini-cli",
  label: "Gemini CLI",

  detect() {
    return fs.existsSync(HOME);
  },

  sessions({ cwd, root = HOME }) {
    const dir = chatsDir(cwd, root);
    if (!fs.existsSync(dir)) return [];

    const out = [];
    for (const file of sessionFiles(dir)) {
      const parent = parseRun(file, cwd, { depth: 0 });
      if (!parent) continue;
      const runs = [parent];
      const subDir = path.join(dir, parent.id);
      if (fs.existsSync(subDir)) {
        try {
          for (const name of fs.readdirSync(subDir).filter((n) => n.endsWith(".jsonl") || n.endsWith(".json"))) {
            const run = parseRun(path.join(subDir, name), cwd, { depth: 1, kind: "subagent" });
            if (run) runs.push(run);
          }
        } catch {
          /* ignore a broken subagent folder */
        }
      }
      runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const measured = runs.filter((r) => r.usageRecorded !== false);
      out.push({
        id: parent.id,
        sourceId: "gemini-cli",
        startedAt: runs.map((r) => r.startedAt).filter(Boolean).sort()[0] || null,
        lastActivityAt: runs.map((r) => r.lastActivityAt).filter(Boolean).sort().pop() || null,
        runs,
        totals: {
          usageRecorded: measured.length ? true : false,
          tokens: measured.reduce((n, r) => n + r.tokens, 0),
          outputTokens: measured.reduce((n, r) => n + r.outputTokens, 0),
          cacheWriteTokens: 0,
          cacheReadTokens: measured.reduce((n, r) => n + r.cacheReadTokens, 0),
          toolCalls: runs.reduce((n, r) => n + r.toolCalls, 0),
          turns: parent.turns,
          contextNow: parent.contextNow || 0,
          model: parent.model,
        },
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  },
};

geminiCli.documents = function documents({ cwd }) {
  const out = [];
  const gemini = path.join(cwd, ".gemini");
  const skills = listMarkdown(path.join(gemini, "skills"), {
    cwd,
    scope: "project",
    kind: "skills",
  });
  if (skills) {
    out.push({ id: "project-skills", label: "Skills (project)", scope: "project", items: skills });
  }
  const geminiMd = path.join(cwd, "GEMINI.md");
  try {
    const stat = fs.statSync(geminiMd);
    out.push({
      id: "project-gemini-md",
      label: "Instructions (project)",
      scope: "project",
      items: [
        {
          id: "project:gemini-md:GEMINI.md",
          name: "GEMINI",
          path: geminiMd.replace(os.homedir(), "~"),
          rel: "GEMINI.md",
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          bytes: stat.size,
          markdown: fs.readFileSync(geminiMd, "utf8"),
        },
      ],
    });
  } catch {
    /* no GEMINI.md */
  }
  return out;
};
