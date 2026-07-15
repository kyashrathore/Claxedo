import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createLocalWorkspaceExecution } from "./local-execution"
import type { StreamID, WorkGraphContext } from "@claxedo/workgraph/contracts"

const cleanup: string[] = []
const run = promisify(execFile)
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))),
)

describe("local WorkGraph workspace execution", () => {
  it("fails closed before Session admission when an Attempt requires Connections", async () => {
    let admitted = false
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: "/tmp/workgraph-connections",
      repositoryDirectory: async () => "/tmp/repository",
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
        attemptId: "attempt_1" as never,
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
    await fs.writeFile(`${repository}/README.md`, "seed")
    await run("git", ["-C", repository, "add", "README.md"])
    await run("git", ["-C", repository, "commit", "-m", "seed"])
    const admissions: Array<{ directory: string; prompt: string }> = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      repositoryDirectory: async () => {
        throw new Error("legacy repository fallback must not be used")
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
    const streamId = "stream_1" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", directory: repository },
      repository: { baseRevision: "HEAD" },
    })
    const adopted = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree", directory: repository },
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
      attemptId: "attempt_1" as never,
      leaseEpoch: 1,
      envelopeId: envelope.id,
      workspaceId: envelope.workspaceId,
      prompt: "Implement it",
      profile,
      connectionIds: [],
    })
    expect(admissions).toEqual([expect.objectContaining({
      directory: envelope.workspaceId,
      title: "Implement the feature",
      prompt: "Implement it",
    })])
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
        release: async (directory) => { released.push(directory) },
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
      environment: { kind: "local_worktree", directory: repository },
      repository: { baseRevision: "HEAD" },
    })

    expect(envelope.workspaceId).toBe("ws_stream_1")
    expect(provisioned).toEqual([
      expect.objectContaining({ repositoryDirectory: repository, baseRevision: "HEAD" }),
    ])
    const launched = await execution.launch(owner(), {
      streamId: "stream_1" as StreamID,
      workItemId: "item_1" as never,
      title: "Implement the feature",
      attemptId: "attempt_1" as never,
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
      environment: { kind: "local_worktree" as const },
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
    const execution = adapter(root, worktrees, async (directory) => { released.push(directory) })
    const streamId = "stream-cleanup" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
    })
    const legacyChild = path.join(
      worktrees,
      encoded("org-a"),
      encoded("owner"),
      encoded(streamId),
      "children",
      encoded("attempt_1"),
    )
    await fs.mkdir(path.dirname(legacyChild), { recursive: true })
    await run("git", ["-C", envelope.workspaceId, "worktree", "add", "--detach", legacyChild, "HEAD"])
    const legacyChildId = `child_${encoded("org-a")}.${encoded("owner")}.${encoded("attempt_1")}` as never
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

  it("launches every Attempt in the Stream workspace and leaves worktree strategy to the agent", async () => {
    const root = await repositoryFixture("workgraph-local-stream-workspace")
    const worktrees = `${root}/worktrees`
    const directories: string[] = []
    const execution = createLocalWorkspaceExecution({
      worktreeRoot: worktrees,
      repositoryDirectory: async () => `${root}/repository`,
      sessions: {
        admit: async (input) => { directories.push(input.directory); return `session_${input.attemptId}` },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
    })
    const streamId = "stream-workspace" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
    })
    await Promise.all(["attempt_1", "attempt_2"].map((attemptId) => execution.launch(owner(), {
      streamId,
      workItemId: `item_${attemptId}` as never,
      title: `Work ${attemptId}`,
      attemptId: attemptId as never,
      leaseEpoch: 1,
      envelopeId: envelope.id,
      workspaceId: envelope.workspaceId,
      prompt: "Work in the Stream workspace",
      profile,
      connectionIds: [],
    })))
    expect(directories).toEqual([envelope.workspaceId, envelope.workspaceId])
    await expect(fs.stat(path.join(path.dirname(envelope.workspaceId), "children"))).rejects.toThrow()
  })
})

const profile = {
  environment: { kind: "local_worktree" as const },
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
  const directory = `${process.env.TMPDIR ?? "/tmp"}/${name}-${crypto.randomUUID()}`
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
  await fs.writeFile(`${repository}/README.md`, "seed")
  await run("git", ["-C", repository, "add", "README.md"])
  await run("git", ["-C", repository, "commit", "-m", "seed"])
  return root
}

function adapter(root: string, worktreeRoot: string, releaseDirectory?: (directory: string) => Promise<void>) {
  return createLocalWorkspaceExecution({
    worktreeRoot,
    repositoryDirectory: async () => `${root}/repository`,
    sessions: {
      admit: async (input) => `session_${input.attemptId}`,
      cancel: async () => undefined,
      result: async () => ({ state: "running" }),
      ...(releaseDirectory ? { releaseDirectory } : {}),
    },
  })
}
