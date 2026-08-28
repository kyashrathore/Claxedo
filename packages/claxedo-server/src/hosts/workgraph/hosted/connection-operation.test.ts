import { describe, expect, it } from "vitest"
import { errors, generateKeyPair } from "jose"
import { mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { ConnectionsUnavailableError } from "@claxedo/connections"
import {
  SourceIssueConfigurationError,
  SourceIssueProviderError,
  SourceIssueResponseError,
  SourceIssueTransportError,
  SourceIssueUnauthorizedError,
} from "@claxedo/workgraph/connectors"
import { ConnectionOperationDeniedError } from "../connection-operation-broker"
import {
  HostedConnectionCredentialUnavailableError,
  HostedConnectionReconnectRequiredError,
} from "./connections"
import {
  createHostedConnectionOperationExecutor,
  createHostedConnectionOperationHandler,
} from "./connection-operation"

describe("hosted Connection operation endpoint", () => {
  it("resolves the personal Run binding by the verified organization and user", async () => {
    const queries: Record<string, unknown>[] = []
    const execute = createHostedConnectionOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        query: async (_fn, args) => {
          queries.push(args)
          return null
        },
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, requestBody("workspace")))
      .rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    expect(queries).toEqual([expect.objectContaining({
      service_token: "service-secret",
      orgId: "org-acme",
      ownerUserId: "alice",
      runId: "run",
      workspaceId: "workspace",
      connectionId: "connection",
    })])
  })

  it("stops a first public non-draft PR at durable owner authorization before credentials are opened", async () => {
    const mutations: Record<string, unknown>[] = []
    const execute = createHostedConnectionOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        query: async () => ({
          context: { ownerUserId: "alice", ownerPartition: "org:org-acme" },
          runId: "master_stream_1",
          sessionId: "ses_master_stream_1",
          workspaceId: "workspace",
          connectionIds: ["connection"],
          tools: ["connection_code_host_open_pr"],
          streamId: "stream_1",
          connection: {
            id: "connection",
            integrationId: "github",
            capabilities: ["code-host"],
            status: "connected",
            accountLabel: "Claxedo GitHub",
            fields: { installation_id: "123" },
            tokenType: "bearer",
            orgId: "org-acme",
          },
        }),
        mutation: async (_fn, args) => {
          mutations.push(args)
          return { allowed: false }
        },
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, {
      version: 1,
      identity: {
        runId: "master_stream_1",
        sessionId: "ses_master_stream_1",
        workspaceId: "workspace",
        connectionId: "connection" as never,
      },
      operation: {
        type: "open_pull_request",
        repository: "claxedo/app",
        head: "workgraph/v2",
        base: "dev",
        title: "Release WorkGraph V2",
        draft: false,
        publicRepository: true,
        idempotencyKey: "stream_1:pr",
      },
    })).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    expect(mutations).toEqual([expect.objectContaining({
      ownerUserId: "alice",
      orgId: "org-acme",
      streamId: "stream_1",
      runId: "master_stream_1",
      repository: "claxedo/app",
      draft: false,
      publicRepository: true,
    })])
  })

  it("returns a completed PR outbox result without reopening credentials", async () => {
    let mutations = 0
    const execute = createHostedConnectionOperationExecutor({
      env: { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      executor: {
        query: async () => ({
          context: { ownerUserId: "alice", ownerPartition: "org:org-acme" },
          runId: "master_stream_1",
          sessionId: "ses_master_stream_1",
          workspaceId: "workspace",
          connectionIds: ["connection"],
          tools: ["connection_code_host_open_pr"],
          streamId: "stream_1",
          connection: {
            id: "connection",
            integrationId: "github",
            capabilities: ["code-host"],
            status: "connected",
            fields: { installation_id: "123" },
            orgId: "org-acme",
          },
        }),
        mutation: async () => {
          mutations++
          if (mutations === 1) return { allowed: true }
          return {
            state: "completed",
            result: {
              type: "open_pull_request",
              pullRequestId: "42",
              url: "https://github.com/claxedo/app/pull/42",
              draft: true,
              durableEffectReceiptId: "receipt_pr_42",
              evidenceId: "evidence_pr_42",
            },
          }
        },
      },
    })!

    await expect(execute({ ownerUserId: "alice", orgId: "org-acme" }, {
      version: 1,
      identity: {
        runId: "master_stream_1",
        sessionId: "ses_master_stream_1",
        workspaceId: "workspace",
        connectionId: "connection" as never,
      },
      operation: {
        type: "open_pull_request",
        repository: "claxedo/app",
        head: "workgraph/v2",
        base: "dev",
        title: "Release WorkGraph V2",
        draft: true,
        publicRepository: true,
        idempotencyKey: "stream_1:pr",
      },
    })).resolves.toMatchObject({
      type: "open_pull_request",
      pullRequestId: "42",
      durableEffectReceiptId: "receipt_pr_42",
    })
    expect(mutations).toBe(2)
  })

  it("derives owner and org only from a verified exact-workspace RAT", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "alice",
      actorKind: "human",
      orgId: "org-acme",
      workspaceId: "workspace",
      hostId: "host",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    const principals: unknown[] = []
    const handler = createHostedConnectionOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async (principal) => {
        principals.push(principal)
        return { type: "comment", ok: true }
      },
    })
    const response = await handler(request(token, "workspace"))

    expect(response.status).toBe(200)
    expect(principals).toEqual([{ ownerUserId: "alice", orgId: "org-acme" }])
    expect(await response.json()).toEqual({ type: "comment", ok: true })
  })

  it("denies missing tokens and tokens minted for another workspace", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "alice",
      actorKind: "human",
      orgId: "org-acme",
      workspaceId: "other",
      hostId: "host",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    let calls = 0
    const handler = createHostedConnectionOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(keys.publicKey),
      execute: async () => {
        calls++
        return { type: "comment", ok: true }
      },
    })

    const missing = await handler(request(undefined, "workspace"))
    const invalid = await handler(request("not-a-runtime-token", "workspace"))
    const mismatch = await handler(request(token, "workspace"))

    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: { code: "runtime_access_token_required" } })
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_relay_token", retryable: false } })
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: "relay_token_workspace_mismatch", retryable: false } })
    expect(calls).toBe(0)
  })

  it("maps typed Connection and provider failures without exposing their messages", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "alice",
      actorKind: "human",
      orgId: "org-acme",
      workspaceId: "workspace",
      hostId: "host",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    const cases = [
      { error: new ConnectionOperationDeniedError("binding-secret"), status: 403, code: "connection_operation_denied" },
      { error: new HostedConnectionReconnectRequiredError("connection-secret"), status: 409, code: "hosted_connection_reconnect_required" },
      { error: new HostedConnectionCredentialUnavailableError("connection-secret"), status: 503, code: "hosted_connection_credential_unavailable" },
      { error: new ConnectionsUnavailableError(), status: 503, code: "connections_unavailable" },
      { error: new SourceIssueConfigurationError("jira provider-secret", "site_url"), status: 409, code: "connection_provider_configuration_required" },
      { error: new SourceIssueUnauthorizedError("provider-secret"), status: 401, code: "connection_provider_unauthorized" },
      { error: new SourceIssueResponseError("provider-secret"), status: 502, code: "connection_provider_invalid_response" },
      { error: new SourceIssueTransportError("provider-secret"), status: 503, code: "connection_provider_unavailable" },
      { error: new SourceIssueProviderError("github", 403), status: 403, code: "connection_provider_rejected" },
      { error: new SourceIssueProviderError("github", 429), status: 429, code: "connection_provider_rate_limited" },
      { error: new SourceIssueProviderError("github", 503), status: 503, code: "connection_provider_unavailable" },
      { error: new Error("operation-secret"), status: 500, code: "connection_operation_failed" },
    ]

    for (const value of cases) {
      const handler = createHostedConnectionOperationHandler({
        env: {},
        runtimeKey: Promise.resolve(keys.publicKey),
        execute: async () => { throw value.error },
      })
      const response = await handler(request(token, "workspace"))
      const body = await response.text()

      expect(response.status).toBe(value.status)
      expect(JSON.parse(body)).toMatchObject({ error: { code: value.code } })
      expect(body).not.toContain("secret")
    }
  })

  it("reports malformed requests as validation errors instead of authorization denials", async () => {
    const handler = createHostedConnectionOperationHandler({
      env: {},
      execute: async () => ({ type: "comment" as const, ok: true as const }),
    })
    const response = await handler(new Request("https://central.test/internal/workgraph/connection-operation", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: "not-json",
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "connection_operation_invalid_request",
        message: "Connection operation request is invalid",
        retryable: false,
      },
    })

    const unauthenticated = await handler(new Request("https://central.test/internal/workgraph/connection-operation", {
      method: "POST",
      body: "not-json",
    }))
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({ error: { code: "runtime_access_token_required" } })
  })

  it("reports an unavailable runtime token verifier as retryable service unavailability", async () => {
    const keys = await generateKeyPair("Ed25519")
    const token = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "alice",
      actorKind: "human",
      orgId: "org-acme",
      workspaceId: "workspace",
      hostId: "host",
      role: "owner",
    }, keys.privateKey, "EdDSA")
    const handler = createHostedConnectionOperationHandler({
      env: {},
      execute: async () => ({ type: "comment" as const, ok: true as const }),
    })

    const remote = createHostedConnectionOperationHandler({
      env: {},
      runtimeKey: Promise.resolve(async () => { throw new errors.JWKSTimeout() }),
      execute: async () => ({ type: "comment" as const, ok: true as const }),
    })

    for (const response of [await handler(request(token, "workspace")), await remote(request(token, "workspace"))]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: {
          code: "runtime_access_token_verification_unavailable",
          message: "Runtime access token verification is unavailable",
          retryable: true,
        },
      })
    }
  })
})

function request(token: string | undefined, workspaceId: string) {
  return new Request("https://central.test/internal/workgraph/connection-operation", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(requestBody(workspaceId)),
  })
}

function requestBody(workspaceId: string) {
  return {
    version: 1 as const,
    identity: { runId: "run", sessionId: "session", workspaceId, connectionId: "connection" },
    operation: { type: "comment" as const, externalId: "42", body: "Done", idempotencyKey: "once" },
  }
}
