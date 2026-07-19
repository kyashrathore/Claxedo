import { describe, expect, it, vi } from "vitest"
import { generateKeyPair } from "jose"
import { mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import {
  createHostedAttemptOperationExecutor,
  createHostedAttemptOperationHandler,
} from "./hosted-attempt-operation"
import { HostedTranscriptRetentionError } from "./hosted-runtime"

describe("hosted Attempt operation endpoint", () => {
  it("maps verified runtime identity into one service-authenticated WorkGraph command", async () => {
    const mutations: Record<string, unknown>[] = []
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        mutation: async (_fn, args) => {
          mutations.push(args)
          return { ok: true, operationId: "operation-1", cursor: "1", value: { recorded: true } }
        },
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, operation())).resolves.toMatchObject({ ok: true })
    expect(mutations).toEqual([expect.objectContaining({
      service_token: "service-secret",
      organization_id: "org-acme",
      owner_subject: "alice",
      actor_type: "agent",
      actor_id: "attempt-1",
      operation_id: "operation-1",
      command: {
        version: 1,
        type: "record_attempt_checkpoint",
        attemptId: "attempt-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        leaseEpoch: 3,
        level: "milestone",
        summary: "Boundary complete",
        evidenceIds: [],
      },
    })])
  })

  it("maps an exact hosted master binding into a CAS-protected structured notes command", async () => {
    const mutations: Record<string, unknown>[] = []
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        mutation: async (_fn, args) => {
          mutations.push(args)
          if (!("command" in args)) return { version: 7 }
          return { ok: true, operationId: "notes-1", cursor: "1", value: { recorded: true } }
        },
      },
    })!
    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, notesOperation())).resolves.toMatchObject({ ok: true })
    expect(mutations).toEqual([
      expect.objectContaining({ stream_id: "stream-1", owner_subject: "alice" }),
      expect.objectContaining({
        actor_id: "ses_master_stream-1",
        command: {
          version: 1,
          type: "update_stream_notes",
          streamId: "stream-1",
          expectedVersion: 7,
          status: ["Ready"],
          learnings: [],
          externalReferences: [],
        },
      }),
    ])
  })

  it("delivers an owner-scoped master notification before recording its integration receipt", async () => {
    const mutations: Record<string, unknown>[] = []
    const notifyOwner = vi.fn(async () => ({
      channel: "slack",
      reference: "channel:slack:slack:team:channel:thread",
      duplicate: false,
    }))
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      notifyOwner,
      executor: {
        mutation: async (_fn, args) => {
          mutations.push(args)
          return { ok: true, operationId: "notify-1", cursor: "1", value: { evidenceId: "evidence-notify" } }
        },
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, notificationOperation()))
      .resolves.toMatchObject({ ok: true })
    expect(notifyOwner).toHaveBeenCalledWith({
      ownerUserId: "alice",
      orgId: "org-acme",
      idempotencyKey: "notify-1",
      text: "Stream is ready",
    })
    expect(mutations).toEqual([expect.objectContaining({
      actor_id: "ses_master_stream-1",
      command: {
        version: 1,
        type: "record_evidence",
        subject: { type: "stream", streamId: "stream-1" },
        evidence: {
          kind: "integration",
          summary: "Notified the Stream owner through slack",
          effect: "published",
          reference: "channel:slack:slack:team:channel:thread",
        },
      },
    })])
  })

  it("rings live-sync after an agent command without failing the durable result when the nudge fails", async () => {
    const changed: unknown[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        mutation: async () => ({ ok: true, operationId: "operation-1", cursor: "1", value: null }),
      },
      notifyChanged: async (principal) => {
        changed.push(principal)
        throw new Error("room unavailable")
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, operation())).resolves.toMatchObject({ ok: true })
    expect(changed).toEqual([{ ownerUserId: "alice", orgId: "org-acme" }])
    expect(error).toHaveBeenCalledWith(
      "[claxedo-server] WARN  hosted agent workgraph.changed nudge failed:",
      expect.any(Error),
    )
    error.mockRestore()
  })

  it("derives owner and organization from an exact-workspace runtime token", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      subject: "alice",
      orgId: "org-acme",
      workspaceId: "workspace-1",
      hostId: "host-1",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    const principals: unknown[] = []
    const handler = createHostedAttemptOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async (principal, request) => {
        principals.push({ principal, identity: request.identity })
        return { ok: true, operationId: request.operation.operationId, cursor: "1" as never, value: null }
      },
    })

    const response = await handler(request(token))
    expect(response.status).toBe(200)
    expect(principals).toEqual([{
      principal: { ownerUserId: "alice", orgId: "org-acme" },
      identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1", leaseEpoch: 3 },
    }])
  })

  it("nudges the settlement dispatcher after a successful agent-tool operation", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      subject: "alice",
      orgId: "org-acme",
      workspaceId: "workspace-1",
      hostId: "host-1",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    const nudged: Array<{ ownerUserId: string; orgId: string }> = []
    const handler = createHostedAttemptOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async (_principal, request) => ({ ok: true, operationId: request.operation.operationId, cursor: "1" as never, value: null }),
    })

    const ok = await handler(request(token, completion()), (principal) => nudged.push(principal))
    expect(ok.status).toBe(200)
    expect(nudged).toEqual([{ ownerUserId: "alice", orgId: "org-acme" }])

    // A failing durable command does not nudge settlement.
    const failingHandler = createHostedAttemptOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async (_principal, request) => ({
        ok: false,
        operationId: request.operation.operationId,
        error: { code: "version_conflict", message: "stale", retryable: false },
      }),
    })
    const rejected: unknown[] = []
    await failingHandler(request(token, completion()), (principal) => rejected.push(principal))
    expect(rejected).toEqual([])
  })

  it("retains the transcript before accepting complete_attempt and not for checkpoints", async () => {
    const calls: string[] = []
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        mutation: async (_fn, args) => {
          calls.push(`mutation:${(args.command as { type?: string }).type}`)
          return { ok: true, operationId: "operation-1", cursor: "1", value: { recorded: true } }
        },
      },
      retainTranscript: async (input) => {
        calls.push(`retain:${input.workspaceId}/${input.sessionId}:${input.organizationId}:${input.ownerSubject}`)
      },
    })!

    await execute({ ownerUserId: "alice", orgId: "org-acme" }, completion())
    await execute({ ownerUserId: "alice", orgId: "org-acme" }, operation())
    expect(calls).toEqual([
      "retain:workspace-1/session-1:org-acme:alice",
      "mutation:complete_attempt",
      "mutation:record_attempt_checkpoint",
    ])
  })

  it("rejects completion as retryable when transcript retention fails, without settling the Attempt", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      subject: "alice",
      orgId: "org-acme",
      workspaceId: "workspace-1",
      hostId: "host-1",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    let mutationCalls = 0
    const execute = createHostedAttemptOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        mutation: async () => {
          mutationCalls++
          return { ok: true, operationId: "operation-1", cursor: "1", value: null }
        },
      },
      retainTranscript: async () => {
        throw new HostedTranscriptRetentionError("Hosted Session transcript failed: 502 boom")
      },
    })!
    const response = await createHostedAttemptOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute,
    })(request(token, completion()))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: "attempt_transcript_not_retained", retryable: true },
    })
    expect(mutationCalls).toBe(0)
  })

  it("rejects a runtime token minted for another workspace", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      subject: "alice",
      orgId: "org-acme",
      workspaceId: "workspace-2",
      hostId: "host-1",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    let calls = 0
    const response = await createHostedAttemptOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async () => {
        calls++
        return { ok: true, operationId: "operation-1" as never, cursor: "1" as never, value: null }
      },
    })(request(token))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "relay_token_workspace_mismatch" } })
    expect(calls).toBe(0)
  })
})

function operation() {
  return {
    version: 1 as const,
    identity: {
      attemptId: "attempt-1" as never,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      leaseEpoch: 3,
    },
    operation: {
      type: "record_checkpoint" as const,
      operationId: "operation-1" as never,
      level: "milestone" as const,
      summary: "Boundary complete",
      evidenceIds: [],
    },
  }
}

function completion() {
  return {
    version: 1 as const,
    identity: {
      attemptId: "attempt-1" as never,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      leaseEpoch: 3,
    },
    operation: {
      type: "complete" as const,
      operationId: "operation-1" as never,
      summary: "Task complete",
      artifacts: [],
      evidence: [
        {
          requirementId: "requirement-1" as never,
          evidence: { kind: "test_result" as const, summary: "verified", passed: true },
        },
      ],
    },
  }
}

function notesOperation() {
  return {
    version: 1 as const,
    identity: {
      attemptId: "master_stream-1" as never,
      streamId: "stream-1" as never,
      sessionId: "ses_master_stream-1",
      workspaceId: "workspace-1",
    },
    operation: {
      type: "update_stream_notes" as const,
      operationId: "notes-1" as never,
      status: ["Ready"],
      learnings: [],
      externalReferences: [],
    },
  }
}

function notificationOperation() {
  return {
    version: 1 as const,
    identity: {
      attemptId: "master_stream-1" as never,
      streamId: "stream-1" as never,
      sessionId: "ses_master_stream-1",
      workspaceId: "workspace-1",
    },
    operation: {
      type: "notify_owner" as const,
      operationId: "notify-1" as never,
      message: "Stream is ready",
    },
  }
}

function request(token?: string, body: Record<string, unknown> = operation()) {
  return new Request("https://central.test/internal/workgraph/attempt-operation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}
