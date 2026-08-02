import os from "node:os"
import { repoRoot } from "./storage"
import { app } from "./targets"
import type { RunAttribution } from "./types"

export function runAttribution(input: {
  browserVersion?: string
  server?: {
    baseUrl: string
    mockPort?: number
    command?: string
  }
}): RunAttribution {
  const git_sha = git(["rev-parse", "HEAD"], "unknown")
  const git_branch = git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown")
  return {
    git_sha,
    git_branch,
    git_dirty: git(["status", "--porcelain"], "").length > 0,
    command: process.argv.join(" "),
    cwd: process.cwd(),
    bun_version: Bun.version,
    platform: `${process.platform}/${process.arch} ${os.release()}`,
    target_package_dir: app.package_dir,
    adapter: "browser",
    browser: input.browserVersion ? { name: "chromium", version: input.browserVersion } : undefined,
    server: input.server
      ? {
          base_url: input.server.baseUrl,
          mock_port: input.server.mockPort,
          dev_command: input.server.command ?? app.command,
        }
      : undefined,
    app_build_identity: `${app.id}:${app.package_dir}:${git_branch}:${git_sha}`,
  }
}

function git(args: string[], fallback: string) {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) return fallback
  return new TextDecoder().decode(result.stdout).trim()
}
