/**
 * Cursor source.
 *
 * Reads agent transcripts from ~/.cursor/projects/<encoded-cwd>/agent-transcripts/,
 * where each conversation is a folder of .jsonl (the parent run) plus optional
 * subagents/.
 *
 * Cursor transcripts do not record token usage. Tokens stay 0 rather than
 * being guessed — a measured zero, not a missing measurement dressed as one.
 *
 * Everything vendor-specific lives here. The rest of runlanes only sees
 * the normalised types.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusFromLastWrite, orderFileEvents } from "./types.js";
import { readJsonl, repoRelative, classifyCommand } from "./read.js";

const ROOT = path.join(os.homedir(), ".cursor", "projects");

const WRITE_TOOLS = new Set(["Write", "StrReplace", "Delete", "EditNotebook"]);

/** Parsed transcripts, invalidated on mtime — history re-reads a lot. */
const cache = new Map();

/**
 * Cursor encodes a project path by stripping the leading separator and
 * replacing separators and whitespace with "-".
 * "/a/My Repo/b" becomes "a-My-Repo-b".
 */
const encode = (p) => p.replace(/^[\\/]+/, "").replace(/[/\\\s]+/g, "-");

function projectDir(cwd, root = ROOT) {
  const want = encode(cwd);
  const direct = path.join(root, want);
  if (fs.existsSync(direct)) return direct;
  const lower = want.toLowerCase();
  try {
    const hit = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .find((d) => d.name.toLowerCase() === lower || lower.endsWith(d.name.toLowerCase()));
    return hit ? path.join(root, hit.name) : null;
  } catch {
    return null;
  }
}

function filesTouched(block, repoRoot) {
  const input = block?.input || {};
  const out = new Set();
  for (const key of ["path", "target_notebook"]) {
    const rel = repoRelative(repoRoot, input[key]);
    if (!rel) continue;
    // Directories (Grep/Glob targets) are not file contacts.
    const abs = path.isAbsolute(input[key]) ? input[key] : path.resolve(repoRoot, input[key]);
    try {
      if (fs.statSync(abs).isDirectory()) continue;
    } catch {
      /* explicit path to a since-deleted file still counts */
    }
    out.add(rel);
  }
  return { paths: out, shell: classifyCommand(input.command, repoRoot) };
}

function flattenText(rec) {
  const content = rec?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function parseStamp(text) {
  const m = String(text).match(/<timestamp>([^<]+)<\/timestamp>/);
  if (!m) return null;
  const raw = m[1].replace(/^[A-Za-z]+,\s+/, "").replace(/\s*\([^)]+\)\s*$/, "");
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function extractModel(rec) {
  const candidates = [rec?.model, rec?.message?.model, rec?.message?.modelName, rec?.message?.model_id];
  for (const m of candidates) {
    if (typeof m === "string" && m && !/^<.*>$/.test(m)) return m;
  }
  return null;
}

function runName(records) {
  for (const rec of records) {
    const m = flattenText(rec).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    if (!m) continue;
    const line = m[1].trim().split(/\n/)[0].replace(/\s+/g, " ");
    if (line) return line.slice(0, 80);
  }
  return "(unnamed)";
}

function parseRun(file, repoRoot, { depth, kind } = {}) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const records = readJsonl(file);
  if (!records.length) return null;

  const id = path.basename(file).replace(/\.jsonl$/, "");
  const reads = new Set();
  const writes = new Set();
  let model = null;
  let toolCalls = 0;
  let turns = 0;
  let first = null;
  let last = null;
  const events = [];
  const unsure = new Set();

  for (const rec of records) {
    if (!model) model = extractModel(rec);
    const text = flattenText(rec);
    const stamp = parseStamp(text) || rec.timestamp || null;
    if (stamp) {
      first = first || stamp;
      last = stamp;
    }
    if (rec.role === "assistant" || rec.message?.role === "assistant") turns++;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      toolCalls++;
      const kind = WRITE_TOOLS.has(b.name) ? "write" : "read";
      const target = kind === "write" ? writes : reads;
      const touched = filesTouched(b, repoRoot);
      for (const f of touched.paths) {
        target.add(f);
        // Cursor stamps its user turns, not its tool calls. Where this record
        // carries no stamp the event says null rather than borrowing the last
        // one seen, which would read as a measurement.
        events.push({ path: f, kind, at: stamp || null });
      }
      for (const f of touched.shell.writes) {
        writes.add(f);
        events.push({ path: f, kind: "write", at: stamp || null });
      }
      for (const f of touched.shell.reads) {
        reads.add(f);
        events.push({ path: f, kind: "read", at: stamp || null });
      }
      for (const f of touched.shell.unknown) {
        unsure.add(f);
        events.push({ path: f, kind: "touch", at: stamp || null });
      }
    }
  }

  for (const w of writes) reads.delete(w);
  for (const w of writes) unsure.delete(w);
  for (const r of reads) unsure.delete(r);

  const mtimeIso = new Date(mtime).toISOString();
  first = first || mtimeIso;
  // The file is rewritten as the agent works; mtime is the recency we have
  // when the transcript only stamps user messages.
  if (!last || mtime > new Date(last).getTime()) last = mtimeIso;

  const value = {
    id,
    name: runName(records),
    kind: kind || null,
    model,
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
    touched: [...unsure].sort(),
    fileEvents: orderFileEvents(events),
    writes: [...writes].sort(),
    depth: depth ?? null,
  };
  cache.set(file, { mtime, value });
  return value;
}

export const cursor = {
  id: "cursor",
  label: "Cursor",

  detect() {
    return fs.existsSync(ROOT);
  },

  sessions({ cwd, root = ROOT }) {
    const dir = projectDir(cwd, root);
    if (!dir) return [];
    const transcripts = path.join(dir, "agent-transcripts");
    if (!fs.existsSync(transcripts)) return [];

    let folders;
    try {
      folders = fs.readdirSync(transcripts, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }

    const out = [];
    for (const folder of folders) {
      const sessionDir = path.join(transcripts, folder.name);
      const parentFile = path.join(sessionDir, `${folder.name}.jsonl`);
      const parent = parseRun(parentFile, cwd, { depth: 0, kind: null });
      const runs = [];
      if (parent) runs.push(parent);

      const subDir = path.join(sessionDir, "subagents");
      if (fs.existsSync(subDir)) {
        for (const f of fs.readdirSync(subDir).filter((n) => n.endsWith(".jsonl"))) {
          const run = parseRun(path.join(subDir, f), cwd, { depth: 1, kind: "subagent" });
          if (run) runs.push(run);
        }
      }
      if (!runs.length) continue;
      runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

      out.push({
        id: folder.name,
        sourceId: "cursor",
        startedAt: runs.map((r) => r.startedAt).filter(Boolean).sort()[0] || null,
        lastActivityAt: runs.map((r) => r.lastActivityAt).filter(Boolean).sort().pop() || null,
        runs,
        totals: {
          usageRecorded: false,
          tokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          toolCalls: runs.reduce((n, r) => n + r.toolCalls, 0),
          contextNow: 0,
          model: runs.map((r) => r.model).find(Boolean) || null,
        },
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  },
};

const DOC_KINDS = [
  { id: "rules", label: "Rules", ext: [".md", ".mdc"] },
  { id: "skills", label: "Skills" },
  { id: "commands", label: "Commands" },
];

const MAX_DOC_BYTES = 256 * 1024;

function readDocs(dir, scope, kind, cwd, ext = [".md"]) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const items = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    let file = full;
    if (stat.isDirectory()) {
      const inner = ["SKILL.md", "README.md", `${name}.md`].map((f) => path.join(full, f));
      file = inner.find((f) => fs.existsSync(f));
      if (!file) continue;
      stat = fs.statSync(file);
    } else if (!ext.some((e) => name.endsWith(e))) {
      continue;
    }
    if (stat.size > MAX_DOC_BYTES) continue;
    let markdown = "";
    try {
      markdown = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    items.push({
      id: `${scope}:${kind}:${name}`,
      name: name.replace(/\.(md|mdc)$/, ""),
      path: file.replace(os.homedir(), "~"),
      rel: repoRelative(cwd, file),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      bytes: stat.size,
      markdown,
    });
  }
  if (!items.length) return null;
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items;
}

cursor.documents = function documents({ cwd }) {
  const base = path.join(cwd, ".cursor");
  const out = [];
  for (const kind of DOC_KINDS) {
    const items = readDocs(path.join(base, kind.id), "project", kind.id, cwd, kind.ext);
    if (!items) continue;
    out.push({
      id: `project-${kind.id}`,
      label: `${kind.label} (project)`,
      scope: "project",
      items,
    });
  }
  return out;
};
