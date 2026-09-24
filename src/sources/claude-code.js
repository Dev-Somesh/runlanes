/**
 * Claude Code source.
 *
 * Reads transcripts from ~/.claude/projects/<encoded-cwd>/, where each session
 * is a .jsonl file alongside a directory of the subagents it spawned.
 *
 * Everything vendor-specific lives here: the paths, the record shape, the
 * sidecar files. The rest of runlanes only sees the normalised types.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumedTokens, statusFromLastWrite, orderFileEvents } from "./types.js";
import { readJsonl, repoRelative, classifyCommand } from "./read.js";

const ROOT = path.join(os.homedir(), ".claude", "projects");

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Parsed transcripts, invalidated on mtime — history re-reads a lot. */
const cache = new Map();

/**
 * Claude encodes a project path by replacing separators AND whitespace with
 * "-", so "/a/My Repo/b" becomes "-a-My-Repo-b".
 */
const encode = (p) => p.replace(/[/\s]+/g, "-");

function projectDir(cwd, root = ROOT) {
  const direct = path.join(root, encode(cwd));
  if (fs.existsSync(direct)) return direct;
  // Fall back to a case-insensitive match on the encoded name.
  const want = encode(cwd).toLowerCase();
  try {
    const hit = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .find((d) => d.name.toLowerCase() === want || want.endsWith(d.name.toLowerCase()));
    return hit ? path.join(root, hit.name) : null;
  } catch {
    return null;
  }
}

/**
 * What one tool call did, per path rather than per tool.
 *
 * The tool name settles its own arguments: Edit edits what it was given. It
 * says nothing about a shell command, where one line can read one file and
 * rewrite another, so those paths are classified from the command itself and
 * the ones that cannot be settled are reported as neither.
 */
function filesTouched(block, repoRoot, isWrite) {
  const input = block?.input || {};
  const writes = new Set();
  const reads = new Set();
  const unknown = new Set();
  for (const key of ["file_path", "path", "notebook_path"]) {
    const rel = repoRelative(repoRoot, input[key]);
    if (rel) (isWrite ? writes : reads).add(rel);
  }
  const shell = classifyCommand(input.command, repoRoot);
  for (const f of shell.writes) writes.add(f);
  for (const f of shell.reads) if (!writes.has(f)) reads.add(f);
  for (const f of shell.unknown) if (!writes.has(f) && !reads.has(f)) unknown.add(f);
  return { writes, reads, unknown };
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
  if (!records.length) return null;

  const id = path.basename(file).replace(/^agent-/, "").replace(/\.jsonl$/, "");
  const reads = new Set();
  const writes = new Set();
  const unsure = new Set();
  let model = null;
  let effort = null;
  let tokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let first = null;
  let last = null;
  const events = [];

  for (const rec of records) {
    if (rec.timestamp) {
      first = first || rec.timestamp;
      last = rec.timestamp;
    }
    effort = effort || rec.effort || null;
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;
    // Skip synthetic/meta model ids like "<synthetic>".
    if (!model && msg.model && !/^<.*>$/.test(msg.model)) model = msg.model;
    if (msg.usage) {
      tokens += consumedTokens(msg.usage);
      outputTokens += msg.usage.output_tokens || 0;
      cacheWriteTokens += msg.usage.cache_creation_input_tokens || 0;
      cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
    }
    if (rec.type === "assistant") turns++;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type !== "tool_use") continue;
        toolCalls++;
        const touched = filesTouched(b, repoRoot, WRITE_TOOLS.has(b.name));
        for (const f of touched.writes) {
          writes.add(f);
          events.push({ path: f, kind: "write", at: rec.timestamp || null });
        }
        for (const f of touched.reads) {
          reads.add(f);
          events.push({ path: f, kind: "read", at: rec.timestamp || null });
        }
        for (const f of touched.unknown) {
          unsure.add(f);
          events.push({ path: f, kind: "touch", at: rec.timestamp || null });
        }
      }
    }
  }

  // A file it wrote is not also counted as one it merely read.
  for (const w of writes) reads.delete(w);
  // A path settled as read or written is no longer merely touched.
  for (const w of writes) unsure.delete(w);
  for (const r of reads) unsure.delete(r);

  // The sidecar carries the authoritative name and type.
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    /* older sessions predate the sidecar */
  }

  const value = {
    id,
    name: meta?.description || "(unnamed)",
    kind: meta?.agentType || null,
    model,
    effort,
    status: statusFromLastWrite(last),
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
    writes: [...writes].sort(),
    touched: [...unsure].sort(),
    fileEvents: orderFileEvents(events),
    depth: meta?.spawnDepth ?? null,
  };
  cache.set(file, { mtime, value });
  return value;
}

/** Totals for the parent session itself, not its subagents. */
function sessionTotals(file) {
  let tokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let contextNow = 0;
  let model = null;
  let first = null;
  let last = null;

  for (const rec of readJsonl(file)) {
    if (rec.timestamp) {
      first = first || rec.timestamp;
      last = rec.timestamp;
    }
    const msg = rec?.message;
    if (!msg) continue;
    const m = msg.model;
    if (!model && m && !/^<.*>$/.test(m)) model = m;
    if (rec.type === "assistant") turns++;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) if (b?.type === "tool_use") toolCalls++;
    }
    const u = msg.usage;
    if (!u) continue;
    tokens += consumedTokens(u);
    outputTokens += u.output_tokens || 0;
    cacheWriteTokens += u.cache_creation_input_tokens || 0;
    cacheReadTokens += u.cache_read_input_tokens || 0;
    // Context is the most recent prompt, not a running total.
    contextNow =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
  }
  return {
    tokens, outputTokens, cacheWriteTokens, cacheReadTokens,
    toolCalls, turns, contextNow, model,
    startedAt: first, lastActivityAt: last,
  };
}

export const claudeCode = {
  id: "claude-code",
  label: "Claude Code",

  detect() {
    return fs.existsSync(ROOT);
  },

  sessions({ cwd, root = ROOT }) {
    const dir = projectDir(cwd, root);
    if (!dir) return [];

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ""), file: path.join(dir, f) }));

    const out = [];
    for (const entry of files) {
      const totals = sessionTotals(entry.file);
      if (!totals.tokens) continue; // an empty or aborted session

      const subDir = path.join(dir, entry.id, "subagents");
      const runs = fs.existsSync(subDir)
        ? fs
            .readdirSync(subDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => parseRun(path.join(subDir, f), cwd))
            .filter(Boolean)
            .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
        : [];

      const stamps = [totals.startedAt, ...runs.map((r) => r.startedAt)].filter(Boolean).sort();
      const lastStamps = [totals.lastActivityAt, ...runs.map((r) => r.lastActivityAt)]
        .filter(Boolean)
        .sort();

      out.push({
        id: entry.id,
        sourceId: "claude-code",
        startedAt: stamps[0] || null,
        lastActivityAt: lastStamps.pop() || null,
        runs,
        totals: {
          ...totals,
          status: statusFromLastWrite(totals.lastActivityAt),
        },
      });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  },
};

/**
 * Markdown this runner keeps beside *this* project.
 *
 * User-global folders are ignored on purpose: they mix every repo on the
 * machine, so a plan written for something else would show up here. The
 * package ships its own samples when a project has none.
 */
const DOC_KINDS = [
  { id: "plans", label: "Plans" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "commands", label: "Commands" },
];

const MAX_DOC_BYTES = 256 * 1024;

function readDocs(dir, scope, kind, cwd) {
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
    // A skill is a directory containing SKILL.md; a plan is a bare .md file.
    let file = full;
    if (stat.isDirectory()) {
      const inner = ["SKILL.md", "README.md", `${name}.md`].map((f) => path.join(full, f));
      file = inner.find((f) => fs.existsSync(f));
      if (!file) continue;
      stat = fs.statSync(file);
    } else if (!name.endsWith(".md")) {
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
      name: name.replace(/\.md$/, ""),
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

/**
 * Slugs of sessions belonging to this project.
 *
 * Plans live in `~/.claude/plans`, which is user-wide — showing all of them
 * would put one project's plans in front of another, which is why the user
 * root is not scanned wholesale. But a session records the slug of the plan it
 * was working from, and that slug is the plan's filename. Matching on it shows
 * this project's plan and nothing else.
 */
function projectSlugs(cwd) {
  const dir = projectDir(cwd);
  const slugs = new Set();
  if (!dir) return slugs;
  // The slug is stamped on subagent records rather than reliably near the top
  // of a session file, so both are scanned.
  const files = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith(".jsonl")) files.push(full);
      const subDir = path.join(full, "subagents");
      if (fs.existsSync(subDir)) {
        for (const sub of fs.readdirSync(subDir)) {
          if (sub.endsWith(".jsonl")) files.push(path.join(subDir, sub));
        }
      }
    }
  } catch {
    return slugs;
  }

  for (const file of files) {
    let seen = 0;
    for (const rec of readJsonl(file)) {
      if (rec.slug) {
        slugs.add(rec.slug);
        break; // one slug per transcript is enough
      }
      if (++seen > 200) break;
    }
  }
  return slugs;
}

claudeCode.documents = function documents({ cwd }) {
  const base = path.join(cwd, ".claude");
  const out = [];
  for (const kind of DOC_KINDS) {
    const items = readDocs(path.join(base, kind.id), "project", kind.id, cwd);
    if (!items) continue;
    out.push({
      id: `project-${kind.id}`,
      label: `${kind.label} (project)`,
      scope: "project",
      items,
    });
  }

  // Plans this project actually worked from, matched by session slug rather
  // than by scanning the whole user directory.
  const slugs = projectSlugs(cwd);
  if (slugs.size) {
    const userPlans = readDocs(
      path.join(os.homedir(), ".claude", "plans"),
      "user",
      "plans",
      cwd
    );
    const mine = (userPlans || []).filter((item) => slugs.has(item.name));
    if (mine.length) {
      out.push({ id: "user-plans", label: "Plans", scope: "user", items: mine });
    }
  }

  return out;
};
