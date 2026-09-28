import { expect, test } from "bun:test"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate } from "../test-support/host-fixture"
import { createSessionConfiguration } from "./configure"
import type { TransportConfigUpdate } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { AttachedSession } from "../host/attachments"

test("retry pushes only to attachments that have not acknowledged the configuration", async () => {
  let refused = true
  const accepted = new FakeTransport()
  const retried = new FakeTransport({ configure: () => refused ? { state: "refused", reason: "busy" } : { state: "applied" } })
  const host = createHostFixture({ transports: { pi: accepted, codex: retried } })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "accepted" }))
    await host.runtime.sessions.create(sessionCreate({ id: "refused", harness: { id: "codex", access: "native" } }))
    const configuration = createSessionConfiguration({
      attached: () => host.runtime.attachments.entries(),
      credentials: () => ({ machineLoginAllowed: false, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "new" }),
      projection: () => ({ generation: "new", mcpServers: [], pluginRoots: [], notApplied: [] }),
      providerDefinitions: () => [],
      onHeldFailure: (error) => { throw error },
      retire: async () => { throw new Error("no session is retired here") },
    })
    await expect(configuration.apply({ credentials: true, projection: true, providerDefinitions: false })).rejects.toThrow("refused")
    refused = false
    await configuration.apply({ credentials: false, projection: false, providerDefinitions: false })
    expect(accepted.configures).toHaveLength(1)
    expect(retried.configures).toHaveLength(2)
    expect(retried.configures[1]).toEqual(retried.configures[0])
  } finally { await host.dispose() }
})

function attached(sessionId: string, pushed: TransportConfigUpdate[]): AttachedSession {
  return {
    owner: { kind: "person", userId: sessionId },
    session: { binding: { sessionId } },
    handle: { transport: { configure: async (_session: unknown, update: TransportConfigUpdate) => { pushed.push(update); return { state: "applied" } } } },
  } as unknown as AttachedSession
}

test("a session whose owner has no usable account is retired while the others still receive theirs", async () => {
  const pushed: TransportConfigUpdate[] = []
  const retired: Array<{ sessionId: string; reason: string }> = []
  const configuration = createSessionConfiguration({
    attached: () => [attached("withdrawn", pushed), attached("kept", pushed)],
    projection: () => ({ generation: "g", mcpServers: [], pluginRoots: [], notApplied: [] }),
    credentials: (session) => {
      if (session.owner.kind === "person" && session.owner.userId === "withdrawn") {
        throw new CredentialSelectionError("account_unavailable", "revoked by owner")
      }
      return { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g" }
    },
    providerDefinitions: () => undefined,
    onHeldFailure: () => {},
    retire: async (session, reason) => { retired.push({ sessionId: session.session.binding.sessionId, reason }) },
  })
  await configuration.apply({ credentials: true, projection: false, providerDefinitions: false })
  expect(retired).toEqual([{ sessionId: "withdrawn", reason: "revoked by owner" }])
  expect(pushed).toHaveLength(1)
})
