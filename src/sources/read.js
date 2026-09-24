/**
 * Shared source helpers. Vendor-neutral: path hygiene and jsonl reading.
 *
 * Existence checks apply only when `mustExist` is set — that is, for paths
 * scraped out of shell commands. A regex can invent a name that was never a
 * file. Paths a tool named explicitly are always real, and checking those
 * would erase the history of every file since deleted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a live session may be mid-write */
    }
  }
  return out;
}

export function repoRelative(repoRoot, p, mustExist = false) {
  if (typeof p !== "string" || !p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  if (!abs.startsWith(repoRoot)) return null;
  const rel = abs.slice(repoRoot.length).replace(/^\/+/, "");
  if (!rel || rel.startsWith("node_modules") || rel.startsWith("dist")) return null;
  if (mustExist && !fs.existsSync(abs)) return null;
  return rel;
}

/**
 * File-like tokens pulled out of a shell command. Always existence-checked.
 */
// `\b` after the extension stops `jsx?` eating the `js` in `package.json`
// and inventing `package.js` — the exact false positive this check exists for.
const FILE_RE =
  /(?:^|[\s"'><|])((?:[\w.@-]+\/)*[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|css|html|json|md|ya?ml|py|go|rs|rb|sh))\b/g;

/**
 * Commands whose file arguments are certainly rewritten. Nothing is here
 * unless it cannot mean anything else: `sed -i` edits in place, `tee` writes
 * its argument, `touch` creates it, `rm` removes it. A deletion is a write —
 * the file is not what it was.
 */
const WRITE_CMDS = new Set(["tee", "touch", "rm", "unlink", "truncate", "install"]);

/** Commands whose file arguments are certainly only read. */
const READ_CMDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "rg", "ag", "wc", "diff",
  "sort", "uniq", "jq", "stat", "file", "md5sum", "shasum", "nl", "column",
]);

/** Splits a command line into the pieces that run on their own. */
const segments = (command) => command.split(/\s*(?:\|\||&&|[;|&\n])\s*/).filter(Boolean);

/**
 * What a shell command did to the files it names.
 *
 * `filesFromCommand` answers which paths a command mentions. It cannot say
 * whether they were read or rewritten, and every adapter was filing the lot as
 * reads. A run that rewrites a file through `sed -i` therefore held a read
 * edge, and two runs that both rewrote the same file that way reported no
 * collision at all.
 *
 * Guessing is worse than not knowing. A regex confident enough to call
 * `git checkout -- file` a write will also call `cat file > out.json` one, and
 * a collision that did not happen is more expensive to a reader than a
 * collision that is merely unproven. So this reports three states and leaves
 * the middle one unresolved, the same way a runner that records no usage
 * reports a dash rather than a zero.
 *
 * @returns {{writes: Set<string>, reads: Set<string>, unknown: Set<string>}}
 */
export function classifyCommand(command, repoRoot) {
  const writes = new Set();
  const reads = new Set();
  const unknown = new Set();
  if (typeof command !== "string") return { writes, reads, unknown };

  for (const seg of segments(command)) {
    const paths = [...filesFromCommand(seg, repoRoot)];
    if (!paths.length) continue;

    // A redirect names its target, wherever it sits in the segment.
    const redirected = new Set();
    for (const m of seg.matchAll(/>>?\s*([^\s;|&]+)/g)) {
      const rel = repoRelative(repoRoot, m[1], true);
      if (rel) redirected.add(rel);
    }

    const words = seg.trim().split(/\s+/);
    // `sudo`, `time` and friends sit in front of the command that matters.
    let i = 0;
    while (i < words.length && /^(sudo|env|time|nohup|xargs)$/.test(words[i])) i++;
    const cmd = (words[i] || "").split("/").pop();
    const flags = words.slice(i + 1).filter((w) => w.startsWith("-"));
    const inPlace = flags.some((f) => f === "-i" || f.startsWith("-i.") || f === "--in-place");

    // `cp a b` and `mv a b` rewrite the destination, and `mv` unmakes the source.
    const copyLike = cmd === "cp" || cmd === "mv" || cmd === "rsync";
    const operands = words.slice(i + 1).filter((w) => !w.startsWith("-"));
    const destination = copyLike && operands.length > 1 ? repoRelative(repoRoot, operands[operands.length - 1], true) : null;

    for (const p of paths) {
      if (redirected.has(p)) writes.add(p);
      else if (destination && p === destination) writes.add(p);
      else if (WRITE_CMDS.has(cmd)) writes.add(p);
      else if ((cmd === "sed" || cmd === "perl" || cmd === "awk") && inPlace) writes.add(p);
      else if (cmd === "mv" && operands.length > 1) writes.add(p); // the source is gone too
      else if (READ_CMDS.has(cmd)) reads.add(p);
      else unknown.add(p);
    }
  }

  for (const w of writes) {
    reads.delete(w);
    unknown.delete(w);
  }
  for (const r of reads) unknown.delete(r);
  return { writes, reads, unknown };
}

export function filesFromCommand(command, repoRoot) {
  const out = new Set();
  if (typeof command !== "string") return out;
  for (const m of command.matchAll(FILE_RE)) {
    const rel = repoRelative(repoRoot, m[1], true);
    if (rel) out.add(rel);
  }
  return out;
}

/**
 * True when `p` is this project or a path inside it.
 *
 * `startsWith` on the raw strings would treat `/Users/foo-bar` as inside
 * `/Users/foo`. The separator after the root is what makes the claim.
 */
export function sameProject(repoRoot, p) {
  if (typeof p !== "string" || !p) return false;
  const root = path.resolve(repoRoot);
  const abs = path.resolve(p);
  return abs === root || abs.startsWith(root + path.sep);
}

/** Recurse a tree, collecting files whose names pass `test`. */
export function walkFiles(dir, test) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (!test || test(e.name, full)) out.push(full);
    }
  }
  return out;
}

/**
 * The first complete JSONL records in a file, without reading the rest.
 *
 * Runners that shard every project into one tree (Codex, Copilot) need a cwd
 * check before a full parse. The metadata line is at the top; 64 kB covers it
 * without pulling a multi-megabyte rollout into memory for the wrong project.
 */
export function readJsonlHead(file, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const out = [];
    for (const line of buf.slice(0, n).toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        break; // incomplete last line of the window
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const MAX_DOC_BYTES = 256 * 1024;

/**
 * Markdown a runner keeps beside a project. Empty directories return null so
 * the Docs tab does not grow empty headings.
 */
export function listMarkdown(dir, { cwd, scope, kind, ext = [".md"] } = {}) {
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
