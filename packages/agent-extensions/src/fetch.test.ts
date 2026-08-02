import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { promisify } from "util"
import { fetchGitHubPackageToCache, githubRepoUrl, resolveGitHubSource, type ExecFile } from "./fetch"

const root = path.join(os.tmpdir(), `agent-extensions-fetch-${randomUUID().slice(0, 8)}`)
const data = path.join(root, "data")
const execFileAsync = promisify(nodeExecFile)

async function execFileReal(file: string, args: string[], options?: { cwd?: string }) {
  const result = await execFileAsync(file, args, options)
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}

describe("Agent Extension GitHub fetch", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("builds canonical GitHub repo URLs", () => {
    expect(githubRepoUrl({ type: "github", owner: "acme", repo: "tools" })).toBe("https://github.com/acme/tools.git")
  })

  test("resolves HEAD and ref output to a commit SHA", async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const execFile: ExecFile = async (file, args) => {
      calls.push({ file, args })
      return {
        stdout: "0123456789abcdef0123456789abcdef01234567\tHEAD\n",
        stderr: "",
      }
    }

    await expect(resolveGitHubSource({ type: "github", owner: "acme", repo: "tools" }, execFile)).resolves.toBe("0123456789abcdef0123456789abcdef01234567")
    await expect(resolveGitHubSource({ type: "github", owner: "acme", repo: "tools", ref: "v1" }, execFile)).resolves.toBe("0123456789abcdef0123456789abcdef01234567")
    expect(calls.map((call) => call.args)).toEqual([
      ["ls-remote", "https://github.com/acme/tools.git", "HEAD"],
      ["ls-remote", "https://github.com/acme/tools.git", "v1", "refs/heads/v1", "refs/tags/v1"],
    ])
  })

  test("throws when a ref cannot be resolved", async () => {
    await expect(resolveGitHubSource(
      { type: "github", owner: "acme", repo: "tools", ref: "missing" },
      async () => ({ stdout: "", stderr: "" }),
    )).rejects.toThrow("did not resolve")
  })

  test("fetches a resolved package root into the cache through git commands", async () => {
    const commands: Array<{ file: string; args: string[]; cwd?: string }> = []
    const execFile: ExecFile = async (file, args, options) => {
      commands.push({ file, args, ...(options?.cwd ? { cwd: options.cwd } : {}) })
      if (args[0] === "init") {
        await fs.mkdir(path.join(args[1]!, "packages", "review"), { recursive: true })
        await fs.writeFile(path.join(args[1]!, "packages", "review", "SKILL.md"), "skill")
      }
      return { stdout: "", stderr: "" }
    }

    const result = await fetchGitHubPackageToCache({
      source: { type: "github", owner: "acme", repo: "tools", package_path: "packages/review" },
      resolvedSha: "0123456789abcdef0123456789abcdef01234567",
      dataRoot: data,
      tempRoot: root,
      execFile,
    })

    // The checkout names the resolved SHA rather than FETCH_HEAD so a remote
    // that served a different commit fails the checkout instead of quietly
    // becoming the content we cache and lock.
    expect(commands.map((item) => item.args.slice(0, 3))).toEqual([
      ["init", commands[0]!.args[1]!],
      ["remote", "add", "origin"],
      ["fetch", "--depth", "1"],
      ["checkout", "--detach", "0123456789abcdef0123456789abcdef01234567"],
    ])
    await expect(fs.readFile(path.join(result.path, "SKILL.md"), "utf8")).resolves.toBe("skill")
    await expect(fs.stat(commands[0]!.args[1]!)).rejects.toThrow()
  })

  test("fetches from a local bare git remote and copies the selected package path", async () => {
    const repo = path.join(root, "source")
    const bare = path.join(root, "source.git")
    await fs.mkdir(path.join(repo, "packages", "review"), { recursive: true })
    await fs.writeFile(path.join(repo, "packages", "review", "SKILL.md"), "review skill")
    await execFileReal("git", ["init", "-b", "main"], { cwd: repo })
    await execFileReal("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await execFileReal("git", ["config", "user.name", "Test User"], { cwd: repo })
    await execFileReal("git", ["add", "."], { cwd: repo })
    await execFileReal("git", ["commit", "-m", "add review skill"], { cwd: repo })
    const sha = (await execFileReal("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await execFileReal("git", ["clone", "--bare", repo, bare])

    const commands: string[][] = []
    const execFile: ExecFile = async (file, args, options) => {
      const rewritten = args[0] === "remote" && args[1] === "add"
        ? ["remote", "add", "origin", bare]
        : args
      commands.push(rewritten)
      return execFileReal(file, rewritten, options)
    }

    const result = await fetchGitHubPackageToCache({
      source: { type: "github", owner: "acme", repo: "tools", package_path: "packages/review" },
      resolvedSha: sha,
      dataRoot: data,
      tempRoot: root,
      execFile,
    })

    expect(commands.filter((args) => args[0] === "fetch")).toEqual([["fetch", "--depth", "1", "origin", sha]])
    await expect(fs.readFile(path.join(result.path, "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.readFile(path.join(data, "agent-extensions", "cache", sha, "packages", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
  })
})
