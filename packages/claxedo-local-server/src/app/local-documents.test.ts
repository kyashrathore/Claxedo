import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const execFileAsync = promisify(execFile)

/**
 * Secret-shaped names the daemon process really carries: the config token every
 * `/api/control` mutation accepts, the credential-store bearer, the
 * control-plane machine principal and a JWT signing key.
 *
 * They are planted before the module graph under test loads because the git
 * runner filters `process.env` once, when `workspace-runtime/src/git.ts` is
 * evaluated. A value assigned after that never reaches a git child on any code
 * path, so a test that planted it later would pass while proving nothing.
 */
const DAEMON_SECRETS = {
  CLAXEDO_DAEMON_TOKEN: "synthetic-daemon-token-4f1c",
  CLAXEDO_CREDENTIALS_TOKEN: "synthetic-credentials-token-9ab2",
  CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "synthetic-service-token-1c77",
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "synthetic-private-pem-7d30",
  WORKSPACE_RUNTIME_CONFIG_TOKEN: "synthetic-config-token-e512",
}

const AUTHOR_IDENTITY = {
  GIT_AUTHOR_NAME: "Daemon Documents",
  GIT_AUTHOR_EMAIL: "documents@claxedo.test",
}

const dataRoot = path.join(os.tmpdir(), `local-documents-data-${crypto.randomUUID()}`)
const planted = { ...DAEMON_SECRETS, ...AUTHOR_IDENTITY, CLAXEDO_DATA_DIR: dataRoot }
const previous = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]))
Object.assign(process.env, planted)
await fs.mkdir(dataRoot, { recursive: true })

const { documentGit } = await import("./local-documents")
const { GitEnvironmentError } = await import("@claxedo/workspace-runtime/host")
const { createLocalDocumentsBackend } = await import("@claxedo/server-core/documents/backends/local/backend")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  ClaxedoDB.close()
  await fs.rm(dataRoot, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const ENTRY = {
  origin: "repository",
  placement: "local",
  projectId: "project_1",
  documentId: "document_1",
  workspaceId: "workspace_1",
  relativePath: "docs/plan.md",
} as const

describe("daemon document git", () => {
  test("a repository helper git runs during a document commit sees no daemon credential", async () => {
    const { repository, helpers } = await repositoryFixture()
    const backend = backendFor(repository)
    const base = await backend.repository.gitSnapshot(ENTRY)

    const committed = await backend.repository.commit(ENTRY, {
      message: "document commit",
      expected: { baseCommit: base.head, baseBlobSha: base.blobSha },
    })

    expect(committed.commit).not.toBe(base.head)
    expect(await show(repository, `${committed.commit}:docs/plan.md`)).toBe("# Plan\n")
    expect(await describeCommit(repository, committed.commit)).toBe(
      "Daemon Documents <documents@claxedo.test>|Repository Committer <committer@claxedo.test>|document commit",
    )

    const observed = await recordings(helpers)
    // Positive control for every emptiness assertion below: the helpers really
    // ran, and the scratch index in their environment says they ran inside the
    // document commit rather than during the fixture's own setup.
    expect(observed.map((recording) => recording.file)).not.toEqual([])
    expect(observed.some((recording) => recording.names.has("PATH"))).toBe(true)
    expect(
      observed.some((recording) =>
        path.basename(recording.values.GIT_INDEX_FILE ?? "").startsWith("claxedo-index-"),
      ),
    ).toBe(true)

    for (const name of Object.keys(DAEMON_SECRETS)) {
      expect(
        observed.filter((recording) => recording.names.has(name)).map((recording) => recording.file),
        `${name} reached a repository-configured helper`,
      ).toEqual([])
    }
    for (const [name, value] of Object.entries(DAEMON_SECRETS)) {
      expect(
        observed.filter((recording) => recording.text.includes(value)).map((recording) => recording.file),
        `the value of ${name} reached a repository-configured helper`,
      ).toEqual([])
    }
  })

  test("a caller cannot put a denied name back through the git environment", async () => {
    const { repository } = await repositoryFixture()

    await expect(
      documentGit(["rev-parse", "HEAD"], repository, {
        env: { CLAXEDO_DAEMON_TOKEN: DAEMON_SECRETS.CLAXEDO_DAEMON_TOKEN },
      }),
    ).rejects.toBeInstanceOf(GitEnvironmentError)
    await expect(
      documentGit(["rev-parse", "HEAD"], repository, {
        env: { GIT_INDEX_FILE: path.join(repository, ".git", "caller-index"), GIT_SSH_COMMAND: "attacker" },
      }),
    ).rejects.toBeInstanceOf(GitEnvironmentError)
    await expect(
      documentGit(["rev-parse", "HEAD"], repository, {
        env: { GIT_INDEX_FILE: path.join(repository, ".git", "caller-index") },
      }),
    ).resolves.toMatch(/^[0-9a-f]{40,64}$/)
  })
})

function backendFor(repository: string) {
  return createLocalDocumentsBackend({
    dataDir: () => dataRoot,
    async resolveWorkspace(input) {
      if (input.workspaceId !== ENTRY.workspaceId) return undefined
      return {
        id: ENTRY.workspaceId,
        project_id: ENTRY.projectId,
        directory: repository,
        kind: "local",
        created_at: 1,
        updated_at: 1,
      }
    },
    async sessionMeta() {
      return undefined
    },
    reportError() {},
    runGit: documentGit,
  })
}

/**
 * A committed document in a checkout that makes git execute two of its own
 * helpers: `core.fsmonitor`, which git consults whenever it refreshes the
 * index, and a clean filter, which git runs on the document itself while
 * staging it. Neither is a `.git/hooks/*` entry, so `commit-tree` bypassing
 * commit hooks does not keep them out of a document commit.
 */
async function repositoryFixture() {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-repository-"))
  const helpers = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-helpers-"))
  roots.push(repository, helpers)

  await git(repository, ["init", "--initial-branch=main"])
  await git(repository, ["config", "user.name", "Repository Committer"])
  await git(repository, ["config", "user.email", "committer@claxedo.test"])
  await fs.mkdir(path.join(repository, "docs"))
  await fs.writeFile(path.join(repository, "docs", "plan.md"), "# Plan\n")
  await fs.writeFile(path.join(repository, ".gitattributes"), "*.md filter=claxedospy\n")
  await git(repository, ["add", "docs/plan.md", ".gitattributes"])
  await git(repository, ["commit", "-m", "initial"])

  const spy = async (name: string, body: string) => {
    const file = path.join(repository, ".git", `claxedo-${name}-spy.sh`)
    await fs.writeFile(file, `#!/bin/sh\nenv > "${helpers}/${name}.$$"\n${body}\n`, { mode: 0o755 })
    return file
  }
  // Exiting non-zero tells git the fsmonitor hook is unusable, so it falls back
  // to its own scan and the repository still behaves normally.
  await git(repository, ["config", "core.fsmonitor", await spy("fsmonitor", "exit 1")])
  // A clean filter rewrites what `add` stages, so this one has to be the
  // identity: anything else and the staged blob stops matching the blob the
  // commit asked for, which git-authority reports as a source conflict.
  await git(repository, ["config", "filter.claxedospy.clean", await spy("clean", "cat")])
  // The setup above ran under the helpers; only the document operation should
  // be in evidence.
  await fs.rm(helpers, { recursive: true, force: true })
  await fs.mkdir(helpers)

  return { repository, helpers }
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd })
}

async function show(repository: string, target: string) {
  return (await execFileAsync("git", ["show", target], { cwd: repository })).stdout
}

async function describeCommit(repository: string, commit: string) {
  const format = "%an <%ae>|%cn <%ce>|%s"
  return (await execFileAsync("git", ["show", "-s", `--format=${format}`, commit], { cwd: repository })).stdout.trim()
}

/** Every environment a repository helper recorded, one entry per invocation. */
async function recordings(helpers: string) {
  const names = await fs.readdir(helpers)
  return await Promise.all(
    names.map(async (file) => {
      const text = await fs.readFile(path.join(helpers, file), "utf8")
      const values: Record<string, string> = {}
      for (const line of text.split("\n")) {
        // `env` writes multi-line values as continuation lines, which have no
        // assignment of their own; `text` is what the value assertions scan.
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
        if (match?.[1]) values[match[1]] = match[2] ?? ""
      }
      return { file, text, values, names: new Set(Object.keys(values)) }
    }),
  )
}
