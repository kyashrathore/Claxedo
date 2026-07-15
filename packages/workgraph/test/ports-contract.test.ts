import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type ConnectionID,
  type OperationID,
  type OrganizationID,
  type OwnerUserID,
  type RequestID,
  type StreamID,
  type WorkGraphContext,
  type WorkSourceID,
  type WorkSourceRevisionID,
} from "../src/contracts"
import {
  defineAtomicWorkGraphStore,
  type AtomicCommand,
  type AtomicWorkGraphStore,
  type OwnerQuery,
} from "../src/ports/store"
import type {
  ConnectionCapabilityHandle,
  ConnectionsPort,
  ResolveConnectionCapabilitiesInput,
} from "../src/ports/connections"
import type { WorkspaceExecutionPort } from "../src/ports/workspace-execution"
import type { WorkSourcePort } from "../src/ports/work-source"

const branded = <Type>(value: string) => value as Type

const context: WorkGraphContext = {
  organizationId: branded<OrganizationID>("organization_01"),
  ownerUserId: branded<OwnerUserID>("owner_01"),
  actor: { type: "agent", id: branded("agent_01") },
  requestId: branded<RequestID>("request_01"),
  access: { mode: "owner" },
}

describe("WorkGraph ports", () => {
  it("composes capability-focused atomic commands and owner-scoped queries", async () => {
    const seen: WorkGraphContext[] = []
    const store = defineAtomicWorkGraphStore({
      commands: {
        streams: {
          create: async (owner: WorkGraphContext, input: { operationId: OperationID; title: string }) => {
            seen.push(owner)
            return { id: branded<StreamID>(input.title) }
          },
        },
      },
      queries: {
        streams: {
          read: async (owner: WorkGraphContext, input: { streamId: StreamID }) => {
            seen.push(owner)
            return { id: input.streamId }
          },
        },
      },
    })

    expectTypeOf(store).toMatchTypeOf<AtomicWorkGraphStore>()
    expectTypeOf(store.commands.streams.create).toMatchTypeOf<
      AtomicCommand<{ operationId: OperationID; title: string }, { id: StreamID }>
    >()
    expectTypeOf(store.queries.streams.read).toMatchTypeOf<OwnerQuery<{ streamId: StreamID }, { id: StreamID }>>()

    const created = await store.commands.streams.create(context, {
      operationId: branded<OperationID>("operation_01"),
      title: "stream_01",
    })
    await store.queries.streams.read(context, { streamId: created.id })

    expect(seen).toEqual([context, context])
    expectTypeOf<Parameters<typeof store.commands.streams.create>[1]>().not.toHaveProperty("ownerUserId")
  })

  it("keeps credentials out of resolution inputs and exposes only live capability handles", async () => {
    const requests: ResolveConnectionCapabilitiesInput[] = []
    const handle: ConnectionCapabilityHandle = {
      id: branded<ConnectionID>("connection_01"),
      integrationId: "github",
      capability: "code-host",
      scope: "personal",
      withAuthorization: async (use) => use({ token: "live-token", tokenType: "bearer" }),
      reportAuthFailure: async () => undefined,
    }
    const connections: ConnectionsPort = {
      resolveCapabilities: async (owner, input) => {
        expect(owner).toBe(context)
        requests.push(input)
        return [handle]
      },
    }

    const input: ResolveConnectionCapabilitiesInput = {
      connectionIds: [handle.id],
      capability: "code-host",
    }
    const resolved = await connections.resolveCapabilities(context, input)
    const tokenType = await resolved[0]!.withAuthorization(async (authorization) => authorization.tokenType)

    expect(requests).toEqual([input])
    expect(JSON.stringify(requests)).not.toContain("live-token")
    expect(tokenType).toBe("bearer")
    expectTypeOf<ResolveConnectionCapabilitiesInput>().not.toHaveProperty("token")
    expectTypeOf<ResolveConnectionCapabilitiesInput>().not.toHaveProperty("credentials")
    expectTypeOf<Parameters<ConnectionsPort["resolveCapabilities"]>[0]>().toEqualTypeOf<WorkGraphContext>()
  })

  it("models one Stream workspace and attempt lifecycle", () => {
    expectTypeOf<Parameters<WorkspaceExecutionPort["provisionOrAdopt"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkspaceExecutionPort["launch"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkspaceExecutionPort["cancel"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkspaceExecutionPort["result"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkspaceExecutionPort["cleanup"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkspaceExecutionPort["launch"]>[1]>().not.toHaveProperty("credentials")
    expectTypeOf<Parameters<WorkspaceExecutionPort["launch"]>[1]>().toHaveProperty("connectionIds")
    expectTypeOf<Parameters<WorkspaceExecutionPort["launch"]>[1]>().toHaveProperty("workspaceId")
  })

  it("creates, revises, and reads exact manual Work Source revisions", () => {
    expectTypeOf<Parameters<WorkSourcePort["createManual"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkSourcePort["reviseManual"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkSourcePort["readRevision"]>[0]>().toEqualTypeOf<WorkGraphContext>()
    expectTypeOf<Parameters<WorkSourcePort["createManual"]>[1]>().not.toHaveProperty("ownerUserId")
    expectTypeOf<Parameters<WorkSourcePort["readRevision"]>[1]>().toEqualTypeOf<Readonly<{
      workSourceId: WorkSourceID
      revisionId: WorkSourceRevisionID
    }>>()

    const workSource: WorkSourcePort = {
      createManual: async () => ({ source: undefined as never, revision: undefined as never }),
      reviseManual: async () => ({ source: undefined as never, revision: undefined as never }),
      readSource: async () => undefined,
      readRevision: async () => undefined,
    }
    expectTypeOf(workSource).toMatchTypeOf<WorkSourcePort>()
  })

})
