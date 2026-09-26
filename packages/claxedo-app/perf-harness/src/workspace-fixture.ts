import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"
import { attestWorkspaceFixture, generateWorkspaceFileBytes } from "agent-app-benchmark/workspace-fixture"

export type MaterializedWorkspace = { directory: string; projectId: string }

export async function initializeWorkspace(directory: string, workspaceId: string, fixture?: WorkspaceFixtureManifest) {
  await runGit(["init", "--initial-branch=main", directory])
  if (fixture) {
    await writeWorkspaceRevision(directory, fixture, "initial")
    await runGit(["-C", directory, "add", "--all"])
  }
  await runGit(
    [
      "-C",
      directory,
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      workspaceId ? `Agent app benchmark corpus ${workspaceId}` : "Agent app benchmark corpus",
    ],
    {
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@localhost",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@localhost",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  )
  const projectId = (await runGit(["-C", directory, "rev-list", "--max-parents=0", "HEAD"])).trim()
  if (!/^[0-9a-f]{40}$/u.test(projectId)) throw new Error("Claxedo did not create a canonical workspace project id")
  if (fixture) {
    await writeWorkspaceRevision(directory, fixture, "current")
    await attestMaterializedWorkspace(directory, fixture)
  }
  return projectId
}

async function writeWorkspaceRevision(
  directory: string,
  fixture: WorkspaceFixtureManifest,
  revision: "initial" | "current",
) {
  await Promise.all(
    fixture.files.map(async (file) => {
      const target = workspaceFixturePath(directory, file.path)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, generateWorkspaceFileBytes(fixture.seed, file, revision), { mode: 0o600 })
    }),
  )
}

async function attestMaterializedWorkspace(directory: string, fixture: WorkspaceFixtureManifest) {
  const tracked = splitGitPaths(await runGit(["-C", directory, "ls-tree", "-r", "--name-only", "HEAD"]))
  assertExactPaths(
    tracked,
    fixture.files.map((file) => file.path),
    "tracked files",
  )

  const changed = splitGitPaths(await runGit(["-C", directory, "diff", "--name-only", "--no-renames", "--"]))
  assertExactPaths(changed, fixture.changedFilePaths, "changed files")

  const status = splitGitPaths(await runGit(["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"]))
  const expectedStatus = fixture.changedFilePaths.map((file) => ` M ${file}`)
  assertExactPaths(status, expectedStatus, "working-tree status")

  const digest = await attestWorkspaceFixture(fixture, async (file, revision) => {
    if (revision === "initial") return runGitBytes(["-C", directory, "show", `HEAD:${file}`])
    return new Uint8Array(await readFile(workspaceFixturePath(directory, file)))
  })
  if (digest !== fixture.manifestDigestSha256) {
    throw new Error("Claxedo workspace fixture attested to the wrong digest")
  }
}

function workspaceFixturePath(directory: string, relative: string) {
  const root = path.resolve(directory)
  const target = path.resolve(root, relative)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Claxedo workspace fixture path escapes its root")
  return target
}

function splitGitPaths(output: string) {
  return output.split("\n").filter((item) => item.length > 0)
}

function assertExactPaths(actual: readonly string[], expected: readonly string[], label: string) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
    throw new Error(`Claxedo workspace fixture ${label} do not match the public manifest`)
  }
}

async function runGit(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Claxedo workspace preparation failed: ${(stderr || stdout).trim()}`)
  return stdout
}

async function runGitBytes(args: string[]) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Claxedo workspace preparation failed: ${stderr.trim()}`)
  return new Uint8Array(stdout)
}
