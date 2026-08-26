import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import { realpathSync } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createLocalWorkspaceExecution } from "./execution"
import type { StreamID, WorkGraphContext } from "@claxedo/workgraph/contracts"

const cleanup: string[] = []
const run = promisify(execFile)
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))),
)

describe("local WorkGraph workspace execution", () => {
  it("fails closed before Session admission when a Run requires Connections", async () => {
    let admitted = false
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: "/tmp/workgraph-connections",
      sessions: {
        admit: async () => {
          admitted = true
          return "session_1"
        },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })

    await expect(
      execution.launch(owner(), {
        streamId: "stream_1" as never,
        workItemId: "item_1" as never,
        title: "Use connected code host",
        runId: "run_1" as never,
        leaseEpoch: 1,
        envelopeId: "envelope_1" as never,
        workspaceId: "/tmp/workspace",
        prompt: "Use the connected code host",
        profile: { ...profile, connectionIds: ["connection_1" as never] },
        connectionIds: ["connection_1" as never],
      }),
    ).rejects.toThrow("Session connection capability bridge")
    expect(admitted).toBe(false)
  })

  it("provisions one real git worktree per Stream and admits the session in that directory", async () => {
    const root = await temp("workgraph-local")
    const repository = `${root}/repository`
    const worktrees = `${root}/worktrees`
    await fs.mkdir(repository, { recursive: true })
    await run("git", ["-C", repository, "init"])
    await run("git", ["-C", repository, "config", "user.email", "test@example.com"])
    await run("git", ["-C", repository, "config", "user.name", "Test"])
    // Repo-local so the worktrees inherit it: the runner's global autocrlf
    // (Windows CI) would otherwise check exact-byte fixture files out as CRLF.
    await run("git", ["-C", repository, "config", "core.autocrlf", "false"])
    // Also inherited by worktrees: a rebase's rev-or-path stat of the
    // "<sha>...<sha>" range crossed MAX_PATH under the deep envelope
    // worktree path on Windows CI (run 364: "Filename too long").
    await run("git", ["-C", repository, "config", "core.longpaths", "true"])
    await fs.writeFile(`${repository}/README.md`, "seed")
    await run("git", ["-C", repository, "add", "README.md"])
    await run("git", ["-C", repository, "commit", "-m", "seed"])
    const admissions: Array<{ directory: string; prompt: string }> = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      sessions: {
        admit: async (input) => {
          admissions.push(input)
          return "session_1"
        },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })
    const streamId = "stream_1" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "HEAD" },
    })
    const adopted = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "HEAD" },
      envelopeId: envelope.id,
    })
    expect(adopted.workspaceId).toBe(envelope.workspaceId)
    expect((await run("git", ["-C", envelope.workspaceId, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
      "true",
    )
    await execution.launch(owner(), {
      streamId,
      workItemId: "item_1" as never,
      title: "Implement the feature",
      runId: "run_1" as never,
      leaseEpoch: 1,
      envelopeId: envelope.id,
      workspaceId: envelope.workspaceId,
      prompt: "Implement it",
      profile,
      connectionIds: [],
    })
    expect(admissions).toEqual([
      expect.objectContaining({
        directory: envelope.workspaceId,
        sessionId: "ses_wgrun_run_1",
        title: "Implement the feature",
        prompt: "Implement it",
      }),
    ])
  })

  it("requires every root Stream to name its project directory", async () => {
    const root = await repositoryFixture("workgraph-local-project-required")
    const execution = adapter(root, `${root}/worktrees`)

    await expect(
      execution.provisionOrAdopt(owner(), {
        streamId: "stream-without-project" as StreamID,
        environment: { kind: "local_worktree", placement: "shared" },
        repository: { baseRevision: "HEAD" },
      }),
    ).rejects.toThrow("requires the Stream's project directory")
  })

  it("branches a child Stream envelope from the parent's moving head", async () => {
    const root = await repositoryFixture("workgraph-local-child-stream")
    const execution = adapter(root, `${root}/worktrees`)
    const parentStreamId = "stream-parent" as StreamID
    const parent = await execution.provisionOrAdopt(owner(), {
      streamId: parentStreamId,
      environment: { kind: "local_worktree", placement: "shared", directory: `${root}/repository` },
      repository: { baseRevision: "HEAD" },
    })
    await fs.writeFile(path.join(parent.workspaceId, "parent.txt"), "parent head\n")
    await run("git", ["-C", parent.workspaceId, "add", "parent.txt"])
    await run("git", ["-C", parent.workspaceId, "commit", "-m", "advance parent"])
    const parentHead = (await run("git", ["-C", parent.workspaceId, "rev-parse", "HEAD"])).stdout.trim()

    const child = await execution.provisionOrAdopt(owner(), {
      streamId: "stream-child" as StreamID,
      parentStreamId,
      environment: { kind: "local_worktree", placement: "shared" },
      repository: { baseRevision: "stale-base-is-ignored" },
    })

    expect((await run("git", ["-C", child.workspaceId, "rev-parse", "HEAD"])).stdout.trim()).toBe(parentHead)
    expect(child.repository?.baseRevision).toBe(parentHead)
    expect(await fs.readFile(path.join(child.workspaceId, "parent.txt"), "utf8")).toBe("parent head\n")
  })

  it("revalidates the moving envelope head and mechanically rejects a gamed landing", async () => {
    const root = await repositoryFixture("workgraph-local-landing")
    const repository = `${root}/repository`
    const execution = adapter(root, `${root}/worktrees`)
    const streamId = "stream-landing" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "HEAD" },
    })
    const before = (await run("git", ["-C", envelope.workspaceId, "rev-parse", "HEAD"])).stdout.trim()
    await fs.writeFile(path.join(repository, "honest.ts"), "export const answer = 42\n")
    await run("git", ["-C", repository, "add", "honest.ts"])
    await run("git", ["-C", repository, "commit", "-m", "honest candidate"])
    const honest = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    const receipt = await execution.land!(owner(), {
      streamId,
      candidateRevision: honest,
      expectedHead: before,
    })
    expect(receipt).toMatchObject({ beforeHead: before, diffRef: `${before}..${receipt.afterHead}` })

    await fs.writeFile(path.join(repository, "honest.ts"), "export const answer: any = 42\n")
    await run("git", ["-C", repository, "add", "honest.ts"])
    await run("git", ["-C", repository, "commit", "-m", "gamed candidate"])
    const gamed = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()
    await expect(
      execution.land!(owner(), {
        streamId,
        candidateRevision: gamed,
        expectedHead: receipt.afterHead,
      }),
    ).rejects.toMatchObject({
      code: "landing_integrity_violation",
      findings: [expect.objectContaining({ path: "honest.ts", rule: "typescript_any" })],
    })
    await expect(
      execution.land!(owner(), {
        streamId,
        candidateRevision: gamed,
        expectedHead: before,
      }),
    ).rejects.toThrow("landing_head_changed")
  })

  it("serially lands non-overlapping candidates through one moving envelope head", async () => {
    const root = await repositoryFixture("workgraph-local-landing-funnel")
    const repository = `${root}/repository`
    const execution = adapter(root, `${root}/worktrees`)
    const streamId = "stream-landing-funnel" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "HEAD" },
    })
    const base = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    await run("git", ["-C", repository, "checkout", "--detach", base])
    await fs.writeFile(path.join(repository, "first.ts"), "export const first = true\n")
    await run("git", ["-C", repository, "add", "first.ts"])
    await run("git", ["-C", repository, "commit", "-m", "first candidate"])
    const first = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    await run("git", ["-C", repository, "checkout", "--detach", base])
    await fs.writeFile(path.join(repository, "second.ts"), "export const second = true\n")
    await run("git", ["-C", repository, "add", "second.ts"])
    await run("git", ["-C", repository, "commit", "-m", "second candidate"])
    const second = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    const firstReceipt = await execution.land!(owner(), {
      streamId,
      candidateRevision: first,
      expectedHead: base,
    })
    const secondReceipt = await execution.land!(owner(), {
      streamId,
      candidateRevision: second,
      expectedHead: firstReceipt.afterHead,
    })

    expect(secondReceipt.beforeHead).toBe(firstReceipt.afterHead)
    expect(await fs.readFile(path.join(envelope.workspaceId, "first.ts"), "utf8")).toBe("export const first = true\n")
    expect(await fs.readFile(path.join(envelope.workspaceId, "second.ts"), "utf8")).toBe("export const second = true\n")
  })

  it("rebases the envelope onto a mid-flight trunk commit before revalidating and landing queued work", async () => {
    const root = await repositoryFixture("workgraph-local-scheduled-rebase")
    const repository = `${root}/repository`
    const candidateDirectory = `${root}/candidate`
    await run("git", ["-C", repository, "branch", "trunk"])
    await run("git", ["-C", repository, "worktree", "add", "-b", "task-candidate", candidateDirectory, "trunk"])
    await fs.writeFile(path.join(candidateDirectory, "feature.ts"), "export const feature = 'ready'\n")
    await run("git", ["-C", candidateDirectory, "add", "feature.ts"])
    await run("git", ["-C", candidateDirectory, "commit", "-m", "task candidate"])
    const candidateRevision = (await run("git", ["-C", candidateDirectory, "rev-parse", "HEAD"])).stdout.trim()

    const execution = adapter(root, `${root}/worktrees`)
    const streamId = "stream-scheduled-rebase" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "trunk" },
    })
    const originalHead = (await run("git", ["-C", envelope.workspaceId, "rev-parse", "HEAD"])).stdout.trim()

    await run("git", ["-C", repository, "checkout", "trunk"])
    await fs.writeFile(path.join(repository, "teammate.ts"), "export const teammate = 'landed mid-flight'\n")
    await run("git", ["-C", repository, "add", "teammate.ts"])
    await run("git", ["-C", repository, "commit", "-m", "teammate trunk change"])
    const movingTrunkHead = (await run("git", ["-C", repository, "rev-parse", "trunk"])).stdout.trim()

    // This is the scheduled master's normal git-tool duty: move its serialized
    // envelope to current trunk before it asks the landing port to validate.
    await run("git", ["-C", envelope.workspaceId, "rebase", "trunk"])
    await expect(
      execution.land!(owner(), {
        streamId,
        candidateRevision,
        expectedHead: originalHead,
      }),
    ).rejects.toThrow("landing_head_changed")

    const receipt = await execution.land!(owner(), {
      streamId,
      candidateRevision,
      expectedHead: movingTrunkHead,
    })
    expect(receipt).toMatchObject({ beforeHead: movingTrunkHead, diffRef: `${movingTrunkHead}..${receipt.afterHead}` })
    await expect(fs.readFile(path.join(envelope.workspaceId, "teammate.ts"), "utf8")).resolves.toBe(
      "export const teammate = 'landed mid-flight'\n",
    )
    await expect(fs.readFile(path.join(envelope.workspaceId, "feature.ts"), "utf8")).resolves.toBe(
      "export const feature = 'ready'\n",
    )
  })

  it("uses the registered worktree service and exposes its routable workspace identity", async () => {
    const root = await repositoryFixture("workgraph-registered")
    const repository = `${root}/repository`
    const worktrees = `${root}/worktrees`
    const provisioned: Array<{ repositoryDirectory: string; directory: string; baseRevision: string }> = []
    const released: string[] = []
    const admissions: Array<{ directory: string; workspaceId?: string }> = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      worktrees: {
        provision: async (input) => {
          provisioned.push(input)
          await fs.mkdir(path.join(input.directory, ".git"), { recursive: true })
          return { directory: input.directory, workspaceId: "ws_stream_1" }
        },
        release: async (directory) => {
          released.push(directory)
        },
      },
      sessions: {
        admit: async (input) => {
          admissions.push(input)
          return "session_1"
        },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId: "stream_1" as StreamID,
      environment: { kind: "local_worktree", placement: "shared", directory: repository },
      repository: { baseRevision: "HEAD" },
    })

    expect(envelope.workspaceId).toBe("ws_stream_1")
    expect(provisioned).toEqual([expect.objectContaining({ repositoryDirectory: repository, baseRevision: "HEAD" })])
    const launched = await execution.launch(owner(), {
      streamId: "stream_1" as StreamID,
      workItemId: "item_1" as never,
      title: "Implement the feature",
      runId: "run_1" as never,
      leaseEpoch: 1,
      envelopeId: envelope.id,
      workspaceId: envelope.workspaceId,
      prompt: "Implement it",
      profile,
      connectionIds: [],
    })
    expect(admissions).toEqual([
      expect.objectContaining({ directory: provisioned[0]!.directory, workspaceId: "ws_stream_1" }),
    ])
    expect(launched.projectId).toBe("ws_stream_1")
    await execution.cleanup(owner(), {
      streamId: "stream_1" as StreamID,
      envelopeId: envelope.id,
      reason: "delete",
    })
    expect(released).toEqual([provisioned[0]!.directory])
  })

  it("serializes concurrent provisioning, adopts after restart, and isolates equal Stream IDs by organization and owner", async () => {
    const root = await repositoryFixture("workgraph-local-concurrent")
    const worktrees = `${root}/worktrees`
    const execution = adapter(root, worktrees)
    const request = {
      streamId: "same" as StreamID,
      environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: `${root}/repository` },
      repository: { baseRevision: "HEAD" },
    }
    const [first, second] = await Promise.all([
      execution.provisionOrAdopt(owner("owner-a"), request),
      execution.provisionOrAdopt(owner("owner-a"), request),
    ])
    expect(second.workspaceId).toBe(first.workspaceId)
    const restarted = adapter(root, worktrees)
    expect((await restarted.provisionOrAdopt(owner("owner-a"), { ...request, envelopeId: first.id })).workspaceId).toBe(
      first.workspaceId,
    )
    const otherOwner = await execution.provisionOrAdopt(owner("owner-b"), request)
    expect(otherOwner.workspaceId).not.toBe(first.workspaceId)
    const otherOrganization = await execution.provisionOrAdopt(owner("owner-a", "org-b"), request)
    expect(otherOrganization.workspaceId).not.toBe(first.workspaceId)
    expect(otherOrganization.id).not.toBe(first.id)
  })

  it("removes legacy child worktrees during lifecycle cleanup and surfaces cleanup failure", async () => {
    const root = await repositoryFixture("workgraph-local-cleanup")
    const worktrees = `${root}/worktrees`
    const released: string[] = []
    const execution = adapter(root, worktrees, async (directory) => {
      released.push(directory)
    })
    const streamId = "stream-cleanup" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: `${root}/repository` },
      repository: { baseRevision: "HEAD" },
    })
    const legacyChild = path.join(
      worktrees,
      encoded("org-a"),
      encoded("owner"),
      encoded(streamId),
      "children",
      encoded("run_1"),
    )
    await fs.mkdir(path.dirname(legacyChild), { recursive: true })
    await run("git", ["-C", envelope.workspaceId, "worktree", "add", "--detach", legacyChild, "HEAD"])
    const legacyChildId = `child_${encoded("org-a")}.${encoded("owner")}.${encoded("run_1")}` as never
    await execution.cleanup(owner(), {
      streamId,
      envelopeId: envelope.id,
      reason: "reconcile",
    })
    expect((await run("git", ["-C", legacyChild, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true")
    await execution.cleanup(owner(), {
      streamId,
      envelopeId: envelope.id,
      childIsolationIds: [legacyChildId],
      reason: "reconcile",
    })
    await expect(fs.stat(legacyChild)).rejects.toThrow()
    expect(released).toEqual([legacyChild])
    expect((await run("git", ["-C", envelope.workspaceId, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
      "true",
    )
    await fs.rm(path.join(envelope.workspaceId, ".git"), { force: true })
    await expect(execution.cleanup(owner(), { streamId, envelopeId: envelope.id, reason: "delete" })).rejects.toThrow()
  })

  it("launches every Run in the Stream workspace and leaves worktree strategy to the agent", async () => {
    const root = await repositoryFixture("workgraph-local-stream-workspace")
    const worktrees = `${root}/worktrees`
    const directories: string[] = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      sessions: {
        admit: async (input) => {
          directories.push(input.directory)
          return `session_${input.runId}`
        },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })
    const streamId = "stream-workspace" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "shared", directory: `${root}/repository` },
      repository: { baseRevision: "HEAD" },
    })
    await Promise.all(
      ["run_1", "run_2"].map((runId) =>
        execution.launch(owner(), {
          streamId,
          workItemId: `item_${runId}` as never,
          title: `Work ${runId}`,
          runId: runId as never,
          leaseEpoch: 1,
          envelopeId: envelope.id,
          workspaceId: envelope.workspaceId,
          prompt: "Work in the Stream workspace",
          profile,
          connectionIds: [],
        }),
      ),
    )
    expect(directories).toEqual([envelope.workspaceId, envelope.workspaceId])
    await expect(fs.stat(path.join(path.dirname(envelope.workspaceId), "children"))).rejects.toThrow()
  })

  it("launches isolated Runs in distinct worktrees and reconciles them by Run identity", async () => {
    const root = await repositoryFixture("workgraph-local-run-worktrees")
    const worktrees = `${root}/worktrees`
    const directories: string[] = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      sessions: {
        admit: async (input) => {
          directories.push(input.directory)
          return `session_${input.runId}`
        },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })
    const streamId = "stream-isolated" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", placement: "worktree", directory: `${root}/repository` },
      repository: { baseRevision: "HEAD" },
    })
    const isolatedProfile = {
      ...profile,
      environment: { kind: "local_worktree" as const, placement: "worktree" as const },
    }
    const launches = await Promise.all(
      ["run_1", "run_2"].map((runId) =>
        execution.launch(owner(), {
          streamId,
          workItemId: `item_${runId}` as never,
          title: `Work ${runId}`,
          runId: runId as never,
          leaseEpoch: 1,
          envelopeId: envelope.id,
          workspaceId: envelope.workspaceId,
          childIsolationId: runId as never,
          prompt: "Work in an isolated worktree",
          profile: isolatedProfile,
          connectionIds: [],
        }),
      ),
    )

    expect(new Set(directories).size).toBe(2)
    expect(directories.every((directory) => directory.includes(`${path.sep}runs${path.sep}`))).toBe(true)
    expect(launches.map((launch) => launch.childIsolationId)).toEqual(["run_1", "run_2"])
    await Promise.all(
      directories.map((directory) =>
        run("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"]).then((result) =>
          expect(result.stdout.trim()).toBe("true"),
        ),
      ),
    )

    await execution.cleanup(owner(), {
      streamId,
      envelopeId: envelope.id,
      childIsolationIds: ["run_1" as never, "run_2" as never],
      reason: "reconcile",
    })
    await Promise.all(directories.map((directory) => expect(fs.stat(directory)).rejects.toThrow()))
    await expect(run("git", ["-C", envelope.workspaceId, "rev-parse", "--is-inside-work-tree"])).resolves.toMatchObject(
      { stdout: expect.stringContaining("true") },
    )
  })
})

const profile = {
  environment: { kind: "local_worktree" as const, placement: "shared" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}
function encoded(value: string) {
  return Buffer.from(value).toString("base64url")
}
async function temp(name: string) {
  // A native, realpath'd temp root: "/tmp" is drive-relative on Windows (the
  // code under test resolves it to D:\tmp while the expectations keep the
  // bare form), and .native expands 8.3 short names (RUNNER~1) to what the
  // resolved worktree paths report.
  const base = realpathSync.native(os.tmpdir())
  const directory = path.join(base, `${name}-${crypto.randomUUID()}`)
  cleanup.push(directory)
  await fs.mkdir(directory, { recursive: true })
  return directory
}
function owner(ownerUserId = "owner", organizationId = "org-a"): WorkGraphContext {
  return {
    organizationId: organizationId as never,
    ownerUserId: ownerUserId as never,
    actor: { type: "agent", id: "agent" as never },
    requestId: "request" as never,
    access: { mode: "owner" },
  }
}

async function repositoryFixture(name: string) {
  const root = await temp(name)
  const repository = `${root}/repository`
  await fs.mkdir(repository, { recursive: true })
  await run("git", ["-C", repository, "init"])
  await run("git", ["-C", repository, "config", "user.email", "test@example.com"])
  await run("git", ["-C", repository, "config", "user.name", "Test"])
  // Repo-local so the worktrees inherit it: the runner's global autocrlf
  // (Windows CI) would otherwise check exact-byte fixture files out as CRLF.
  await run("git", ["-C", repository, "config", "core.autocrlf", "false"])
  // See the pin above: worktree git operations need long-path support on
  // Windows CI, where the envelope worktree path sits right at MAX_PATH.
  await run("git", ["-C", repository, "config", "core.longpaths", "true"])
  await fs.writeFile(`${repository}/README.md`, "seed")
  await run("git", ["-C", repository, "add", "README.md"])
  await run("git", ["-C", repository, "commit", "-m", "seed"])
  return root
}

function adapter(root: string, worktreeRoot: string, releaseDirectory?: (directory: string) => Promise<void>) {
  return createLocalWorkspaceExecution({
    worktreeRoot,
    sessions: {
      admit: async (input) => `session_${input.runId}`,
      cancel: async () => undefined,
      result: async () => ({ state: "running" }),
      ...(releaseDirectory ? { releaseDirectory } : {}),
    },
  })
}
