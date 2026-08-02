import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, test } from "vitest"

const directories: string[] = []

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe("shared WorkGraph git-host identity", () => {
  test("the host accepts a bot feature branch but rejects the same credential on protected refs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workgraph-protected-ref-"))
    directories.push(root)
    const remote = path.join(root, "remote.git")
    const seed = path.join(root, "seed")
    const bot = path.join(root, "bot")
    git(root, ["init", "--bare", remote])
    git(root, ["init", seed])
    git(seed, ["config", "user.name", "Fixture owner"])
    git(seed, ["config", "user.email", "owner@example.test"])
    writeFileSync(path.join(seed, "README.md"), "fixture\n")
    git(seed, ["add", "README.md"])
    git(seed, ["commit", "-m", "seed"])
    git(seed, ["branch", "-M", "main"])
    git(seed, ["remote", "add", "origin", remote])
    git(seed, ["push", "origin", "main"])

    const hook = path.join(remote, "hooks", "pre-receive")
    writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  case "$WORKGRAPH_GIT_HOST_IDENTITY:$ref" in
    workgraph-shared-bot:refs/heads/main|workgraph-shared-bot:refs/heads/release/*)
      echo "shared WorkGraph bot cannot update protected ref $ref" >&2
      exit 1
      ;;
  esac
done
`)
    chmodSync(hook, 0o755)

    git(root, ["clone", remote, bot])
    git(bot, ["config", "user.name", "WorkGraph shared bot"])
    git(bot, ["config", "user.email", "workgraph-bot@example.test"])
    git(bot, ["checkout", "-b", "workgraph/stream-1", "origin/main"])
    writeFileSync(path.join(bot, "feature.txt"), "feature\n")
    git(bot, ["add", "feature.txt"])
    git(bot, ["commit", "-m", "feature"])
    git(bot, ["push", "origin", "HEAD:refs/heads/workgraph/stream-1"], "workgraph-shared-bot")

    const protectedPush = git(
      bot,
      ["push", "origin", "HEAD:refs/heads/main"],
      "workgraph-shared-bot",
      false,
    )
    expect(protectedPush.status).not.toBe(0)
    expect(protectedPush.stderr).toContain("shared WorkGraph bot cannot update protected ref refs/heads/main")
    expect(git(remote, ["rev-parse", "refs/heads/main"]).stdout.trim())
      .not.toBe(git(remote, ["rev-parse", "refs/heads/workgraph/stream-1"]).stdout.trim())
  })
})

function git(directory: string, args: string[], identity?: string, check = true) {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...(identity ? { WORKGRAPH_GIT_HOST_IDENTITY: identity } : {}) },
  })
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
  return result
}
