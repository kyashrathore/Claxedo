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
        attemptId: "attempt_1" as never,
        envelopeId: "envelope_1" as never,
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
      repositoryDirectory: async () => repository,
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
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
    })
    const adopted = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree" },
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
      attemptId: "attempt_1" as never,
      envelopeId: envelope.id,
      prompt: "Implement it",
      profile,
      connectionIds: [],
    })
    expect(admissions).toEqual([expect.objectContaining({ directory: envelope.workspaceId, prompt: "Implement it" })])
  })

  it("serializes concurrent provisioning, adopts after restart, and isolates equal Stream IDs by owner", async () => {
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
  })

  it("tracks and removes child worktrees, honors close policy, and surfaces cleanup failure", async () => {
    const root = await repositoryFixture("workgraph-local-cleanup")
    const worktrees = `${root}/worktrees`
    const execution = adapter(root, worktrees)
    const streamId = "stream-cleanup" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
    })
    const child = await execution.createChildIsolation(owner(), {
      streamId,
      envelopeId: envelope.id,
      workItemId: "item_1" as never,
      attemptId: "attempt_1" as never,
    })
    await execution.cleanup(owner(), {
      streamId,
      envelopeId: envelope.id,
      childIsolationIds: [child.id],
      reason: "reconcile",
    })
    await expect(fs.stat(child.workspaceId)).rejects.toThrow()
    expect((await run("git", ["-C", envelope.workspaceId, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
      "true",
    )
    await execution.cleanup(owner(), { streamId, envelopeId: envelope.id, reason: "close", cleanupPolicy: "retain" })
    expect((await run("git", ["-C", envelope.workspaceId, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
      "true",
    )
    await fs.rm(path.join(envelope.workspaceId, ".git"), { force: true })
    await expect(execution.cleanup(owner(), { streamId, envelopeId: envelope.id, reason: "delete" })).rejects.toThrow()
  })

  it("destroys the Stream envelope on close when destroy_on_close is configured", async () => {
    const root = await repositoryFixture("workgraph-local-close")
    const execution = adapter(root, `${root}/worktrees`)
    const streamId = "stream-close" as StreamID
    const envelope = await execution.provisionOrAdopt(owner(), {
      streamId,
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
    })
    await execution.cleanup(owner(), {
      streamId,
      envelopeId: envelope.id,
      reason: "close",
      cleanupPolicy: "destroy_on_close",
    })
    await expect(fs.stat(envelope.workspaceId)).rejects.toThrow()
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
  isolation: "stream" as const,
  cleanup: "destroy_on_close" as const,
  integration: "pull_request" as const,
}
async function temp(name: string) {
  const directory = `${process.env.TMPDIR ?? "/tmp"}/${name}-${crypto.randomUUID()}`
  cleanup.push(directory)
  await fs.mkdir(directory, { recursive: true })
  return directory
}
function owner(ownerUserId = "owner"): WorkGraphContext {
  return {
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

function adapter(root: string, worktreeRoot: string) {
  return createLocalWorkspaceExecution({
    worktreeRoot,
    repositoryDirectory: async () => `${root}/repository`,
    sessions: {
      admit: async (input) => `session_${input.attemptId}`,
      cancel: async () => undefined,
      result: async () => ({ state: "running" }),
    },
  })
}
