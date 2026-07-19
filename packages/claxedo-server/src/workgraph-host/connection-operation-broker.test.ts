import { describe, expect, it } from "vitest"
import type { ConnectionsPort } from "@claxedo/workgraph"
import {
  ActorIDSchema,
  ConnectionIDSchema,
  OwnerUserIDSchema,
  RequestIDSchema,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import {
  CONNECTION_OPERATION_TOOLS,
  ConnectionOperationDeniedError,
  createConnectionOperationBroker,
  type ConnectionOperationBinding,
  type ConnectionOperationIdentity,
} from "./connection-operation-broker"

describe("WorkGraph connection operation broker", () => {
  it("resolves the live credential for every operation and returns only sanitized issue data", async () => {
    const tokens = ["rotated-secret-1", "rotated-secret-2"]
    const seen: string[] = []
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding() },
      connections: connections(async (use) => use({ token: tokens.shift()!, tokenType: "bearer" })),
      connectors: { github: connector(seen) },
    })

    const first = await broker.execute(identity(), list(), principal())
    const second = await broker.execute(identity(), list(), principal())

    expect(seen).toEqual(["rotated-secret-1", "rotated-secret-2"])
    expect(first).toEqual({
      type: "list",
      issues: [{ externalId: "42", title: "Ship", body: "Ready", status: "open", updatedAt: 123 }],
    })
    expect(JSON.stringify({ first, second, binding: binding(), identity: identity() })).not.toContain("rotated-secret")
  })

  it("denies forged identity, connection, and tool values before credential resolution", async () => {
    let authorizationReads = 0
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding() },
      connections: connections(async (use) => {
        authorizationReads++
        return use({ token: "must-not-be-read", tokenType: "bearer" })
      }),
      connectors: { github: connector([]) },
    })
    const attempts = [
      { ...identity(), attemptId: "forged" },
      { ...identity(), sessionId: "forged" },
      { ...identity(), workspaceId: "forged" },
      { ...identity(), connectionId: ConnectionIDSchema.parse("foreign") },
    ]

    for (const value of attempts) await expect(broker.execute(value, list(), principal())).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    await expect(broker.execute(identity(), list(), { ownerUserId: "mallory", ownerPartition: "org:acme" })).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    await expect(broker.execute(identity(), list(), { ownerUserId: "alice", ownerPartition: "org:other" })).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    const withoutTool = binding({ tools: [] })
    const deniedTool = createConnectionOperationBroker({
      bindings: { resolve: async () => withoutTool },
      connections: brokerConnectionsThatMustNotRun(),
      connectors: { github: connector([]) },
    })
    await expect(deniedTool.execute(identity(), list(), principal())).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
    expect(authorizationReads).toBe(0)
  })

  it("denies missing and cross-owner capabilities without opening authorization", async () => {
    for (const capabilities of [[], [{ ...handle(), id: ConnectionIDSchema.parse("foreign") }]]) {
      let reads = 0
      const broker = createConnectionOperationBroker({
        bindings: { resolve: async () => binding() },
        connections: { resolveCapabilities: async () => capabilities.map((value) => ({
          ...value,
          withAuthorization: async (use) => {
            reads++
            return use({ token: "foreign-secret", tokenType: "bearer" })
          },
        })) },
        connectors: { github: connector([]) },
      })
      await expect(broker.execute(identity(), list(), principal())).rejects.toBeInstanceOf(ConnectionOperationDeniedError)
      expect(reads).toBe(0)
    }
  })

  it("marks a live credential broken when the provider rejects it", async () => {
    const failures: string[] = []
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding() },
      connections: {
        resolveCapabilities: async () => [{
          ...handle(),
          withAuthorization: async (use) => use({ token: "expired", tokenType: "bearer" }),
          reportAuthFailure: async (reason) => { failures.push(reason) },
        }],
      },
      connectors: {
        github: {
          ...connector([]),
          list: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }) },
        },
      },
    })

    await expect(broker.execute(identity(), list(), principal())).rejects.toThrow("unauthorized")
    expect(failures).toEqual(["github_401"])
  })

  it("routes an Atlassian Connection through the Jira work-source connector", async () => {
    let comments = 0
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding({ tools: [CONNECTION_OPERATION_TOOLS.comment] }) },
      connections: {
        resolveCapabilities: async () => [{
          ...handle(),
          integrationId: "atlassian",
          withAuthorization: async (use) => use({ token: "jira-token", tokenType: "bearer" }),
        }],
      },
      connectors: {
        jira: {
          provider: "jira",
          list: async () => ({ issues: [] }),
          comment: async () => { comments++ },
          update: async () => undefined,
        },
      },
    })

    await expect(broker.execute(identity(), {
      type: "comment",
      externalId: "CLX-101",
      body: "Done",
      idempotencyKey: "jira-result",
    }, principal())).resolves.toEqual({ type: "comment", ok: true })
    expect(comments).toBe(1)
  })

  it("opens draft pull requests only through a code-host capability and returns no credential material", async () => {
    const calls: unknown[] = []
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding({ tools: [CONNECTION_OPERATION_TOOLS.open_pull_request] }) },
      connections: {
        resolveCapabilities: async (_context, input) => [{
          ...handle(),
          capability: input.capability,
          withAuthorization: async (use) => use({ token: "github-secret", tokenType: "bearer" }),
        }],
      },
      codeHostConnectors: {
        github: {
          provider: "github",
          openPullRequest: async (authorization, input) => {
            calls.push({ authorization, input })
            return { pullRequestId: "42", url: "https://github.com/acme/repo/pull/42", draft: input.draft }
          },
        },
      },
    })

    const result = await broker.execute(identity(), {
      type: "open_pull_request",
      repository: "acme/repo",
      head: "workgraph/stream-1",
      base: "dev",
      title: "feat: ship",
      draft: true,
      publicRepository: true,
      idempotencyKey: "stream-1:pr",
    }, principal())
    expect(result).toEqual({
      type: "open_pull_request",
      pullRequestId: "42",
      url: "https://github.com/acme/repo/pull/42",
      draft: true,
    })
    expect(calls).toEqual([expect.objectContaining({ input: expect.objectContaining({ draft: true }) })])
    expect(JSON.stringify(result)).not.toContain("github-secret")
  })
})

function context(): WorkGraphContext {
  return {
    organizationId: "org-acme" as never,
    ownerUserId: OwnerUserIDSchema.parse("alice"),
    actor: { type: "agent", id: ActorIDSchema.parse("attempt-agent") },
    requestId: RequestIDSchema.parse("request"),
    access: { mode: "owner" },
  }
}

function identity(): ConnectionOperationIdentity {
  return { attemptId: "attempt", sessionId: "session", workspaceId: "workspace", connectionId: ConnectionIDSchema.parse("connection") }
}

function binding(overrides: Partial<ConnectionOperationBinding> = {}): ConnectionOperationBinding {
  return {
    context: context(),
    ownerPartition: "org:acme",
    attemptId: "attempt",
    sessionId: "session",
    workspaceId: "workspace",
    connectionIds: [ConnectionIDSchema.parse("connection")],
    tools: [CONNECTION_OPERATION_TOOLS.list],
    ...overrides,
  }
}

function principal() {
  return { ownerUserId: "alice", ownerPartition: "org:acme" }
}

function handle() {
  return {
    id: ConnectionIDSchema.parse("connection"),
    integrationId: "github",
    capability: "work-source" as const,
    scope: "team" as const,
    reportAuthFailure: async () => undefined,
  }
}

function connections(withAuthorization: Parameters<typeof buildHandle>[0]): ConnectionsPort {
  return { resolveCapabilities: async () => [buildHandle(withAuthorization)] }
}

function buildHandle(withAuthorization: Parameters<ConnectionsPort["resolveCapabilities"]> extends never ? never : <Result>(use: (authorization: { token: string; tokenType: "bearer" | "basic"; fields?: Readonly<Record<string, string>> }) => Promise<Result>) => Promise<Result>) {
  return { ...handle(), withAuthorization }
}

function brokerConnectionsThatMustNotRun(): ConnectionsPort {
  return { resolveCapabilities: async () => { throw new Error("credential resolution must not run") } }
}

function connector(tokens: string[]): SourceIssueConnector {
  return {
    provider: "github",
    list: async (authorization) => {
      tokens.push(authorization.token)
      return { issues: [{ externalId: "42", title: "Ship", body: "Ready", status: "open", updatedAt: 123 }] }
    },
    comment: async () => undefined,
    update: async () => undefined,
  }
}

function list() {
  return { type: "list" as const, providerUserId: "alice-gh", filters: { state: "open" } }
}
