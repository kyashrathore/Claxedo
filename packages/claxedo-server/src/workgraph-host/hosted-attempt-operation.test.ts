import { describe, expect, it } from "vitest"
import { generateKeyPair } from "jose"
import { mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import {
  createHostedAttemptOperationExecutor,
  createHostedAttemptOperationHandler,
} from "./hosted-attempt-operation"

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

function request(token?: string) {
  return new Request("https://central.test/internal/workgraph/attempt-operation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(operation()),
  })
}
