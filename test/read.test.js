import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesFromCommand, repoRelative, sameProject, classifyCommand } from "../src/sources/read.js";

function shellRepo(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-sh-"));
  for (const f of files) {
    fs.mkdirSync(path.join(cwd, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), "x\n");
  }
  return { cwd, clean: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test("a .json filename is not truncated to .js", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "at-re-"));
  fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
  const found = [...filesFromCommand("cat package.json && cat package.js", tmp)];
  assert.deepEqual(found, ["package.json"]);
});

test("an explicit path to a deleted file still counts; a scrape of one does not", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "at-re-"));
  assert.equal(repoRelative(tmp, "src/gone.ts"), "src/gone.ts");
  assert.equal(repoRelative(tmp, "src/gone.ts", true), null);
});

test("a sibling path is not treated as inside the project", () => {
  assert.equal(sameProject("/Users/foo", "/Users/foo"), true);
  assert.equal(sameProject("/Users/foo", "/Users/foo/src"), true);
  assert.equal(sameProject("/Users/foo", "/Users/foo-bar"), false);
  assert.equal(sameProject("/Users/foo", "/Users/elsewhere"), false);
});

// Every adapter used to file a shell-derived path as a read, so a run that
// rewrote a file through the shell held a read edge and two such runs never
// collided. The command itself says more than that, but only sometimes.
test("classifyCommand calls an in-place edit a write", () => {
  const { cwd, clean } = shellRepo(["src/app.ts"]);
  assert.deepEqual([...classifyCommand("sed -i 's/a/b/' src/app.ts", cwd).writes], ["src/app.ts"]);
  clean();
});

test("classifyCommand splits a redirect into the file read and the file written", () => {
  const { cwd, clean } = shellRepo(["src/a.ts", "src/b.ts"]);
  const out = classifyCommand("cat src/a.ts > src/b.ts", cwd);
  assert.deepEqual([...out.reads], ["src/a.ts"]);
  assert.deepEqual([...out.writes], ["src/b.ts"]);
  clean();
});

test("removing a file is a write, because the file is not what it was", () => {
  const { cwd, clean } = shellRepo(["src/old.ts"]);
  assert.deepEqual([...classifyCommand("rm src/old.ts", cwd).writes], ["src/old.ts"]);
  clean();
});

// The point of the three-way split. A pattern confident enough to call this a
// write would also invent collisions that never happened.
test("a command that could mean anything leaves the path unresolved", () => {
  const { cwd, clean } = shellRepo(["config.json"]);
  const out = classifyCommand("./deploy.sh config.json", cwd);
  assert.deepEqual([...out.unknown], ["config.json"]);
  assert.equal(out.writes.size + out.reads.size, 0);
  clean();
});

test("git checkout is not guessed at, though it does rewrite the file", () => {
  const { cwd, clean } = shellRepo(["src/app.ts"]);
  assert.deepEqual([...classifyCommand("git checkout -- src/app.ts", cwd).unknown], ["src/app.ts"]);
  clean();
});

test("reading is recognised as reading rather than swept into unknown", () => {
  const { cwd, clean } = shellRepo(["package.json"]);
  assert.deepEqual([...classifyCommand("grep name package.json", cwd).reads], ["package.json"]);
  clean();
});

test("each half of a chained command is judged on its own", () => {
  const { cwd, clean } = shellRepo(["src/a.ts", "src/b.ts"]);
  const out = classifyCommand("cat src/a.ts && sed -i 's/x/y/' src/b.ts", cwd);
  assert.deepEqual([...out.reads], ["src/a.ts"]);
  assert.deepEqual([...out.writes], ["src/b.ts"]);
  clean();
});

test("a path established as written is not also reported as unresolved", () => {
  const { cwd, clean } = shellRepo(["src/a.ts"]);
  const out = classifyCommand("./thing src/a.ts && sed -i 's/x/y/' src/a.ts", cwd);
  assert.deepEqual([...out.writes], ["src/a.ts"]);
  assert.equal(out.unknown.size, 0);
  clean();
});
