import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeRemote, resolveRepoDir } from "../src/repo";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workgraph-repo-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]) {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (res.status === 0) return;
  throw new Error(res.stderr || res.stdout || `git ${args.join(" ")} failed`);
}

describe("repo helpers", () => {
  it("normalizes github remotes", () => {
    expect(normalizeRemote("git@github.com:OpenAI/OpenCode.git")).toEqual({
      repo_ref: "github:openai/opencode",
      repo_label: "openai/opencode",
    });
  });

  it("resolves a repo binding from a nested project directory", async () => {
    const dir = temp();
    const child = path.join(dir, "packages", "app");

    fs.mkdirSync(child, { recursive: true });
    git(dir, ["init"]);
    git(dir, ["remote", "add", "origin", "https://github.com/OpenAI/OpenCode.git"]);

    await expect(resolveRepoDir(child, { project_id: "p1", project_name: "App" })).resolves.toEqual({
      repo_ref: "github:openai/opencode",
      repo_label: "openai/opencode",
      project_root: fs.realpathSync(dir),
      project_id: "p1",
      project_name: "App",
    });
  });
});
