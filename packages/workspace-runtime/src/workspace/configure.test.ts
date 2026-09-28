import { expect, test } from "bun:test"
import type { TransportConfigUpdate } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { AttachedSession } from "../host/attachments"
import { createSessionConfiguration } from "./configure"

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
    onHeldFailure: () => {},
    retire: async (session, reason) => { retired.push({ sessionId: session.session.binding.sessionId, reason }) },
  })
  await configuration.apply({ credentials: true, projection: false })
  expect(retired).toEqual([{ sessionId: "withdrawn", reason: "revoked by owner" }])
  expect(pushed).toHaveLength(1)
})
