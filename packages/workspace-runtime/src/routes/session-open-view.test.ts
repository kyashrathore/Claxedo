import { afterEach, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { createHarnessComposer } from "@claxedo/harness/compose"
import { acpPeer } from "../test-support/acp-peer"
import { FakeTransport, type FakeTransportOptions } from "@claxedo/session-core/testing"
import { createFakeWorkspaceApp, type FakeConnection, type FakeWorkspaceApp } from "../test-support/fake-workspace-app"

const apps: FakeWorkspaceApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
})

const PI_SHAPED: FakeTransportOptions = { kind: "pi-rpc", capabilities: { todos: false } }
const CODEX_SHAPED: FakeTransportOptions = {
  kind: "codex-app-server",
  capabilities: { todos: true, goals: { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: [] } },
  goals: {
    read: async () => { throw new Error("an idle session's Goal is read from the store") },
    start: async () => { throw new Error("unused") },
    pause: async () => { throw new Error("unused") },
    resume: async () => { throw new Error("unused") },
    stop: async () => { throw new Error("unused") },
    delete: async () => { throw new Error("unused") },
  },
}

function scriptedAcp(peer: ReturnType<typeof acpPeer>) {
  const unused = () => { throw new Error("Unused transport") }
  const composer = createHarnessComposer(peer.services, {
    acp: () => ({ missingContext: async () => { throw new Error("no restore in this test") } }),
    pi: unused, codex: unused, claude: unused, cursor: unused, opencode: unused,
  })
  return composer.connection({ descriptor: { connectionId: "acp", providerKey: "acp", configRevision: 1, enabled: true,
    config: { label: "Scripted ACP", connection: { kind: "process", command: "scripted" } } }, expectedRevision: 1, directory: "/repo", secrets: {} })
}

/** One host per boot over the same state root, so the second boot holds no attachment for the sessions the first created. */
function connections(peer: ReturnType<typeof acpPeer>, fakes: FakeTransport[]): FakeConnection[] {
  const fake = (connectionId: string, options: FakeTransportOptions): FakeConnection => ({
    connectionId, transport: () => { const transport = new FakeTransport(options); fakes.push(transport); return transport },
  })
  return [fake("pi", PI_SHAPED), fake("codex", CODEX_SHAPED), { connectionId: "scripted-acp", transport: () => scriptedAcp(peer) }]
}

test("opening an idle Pi, Codex or ACP session answers every fact without attaching the session or launching its harness", async () => {
  const peer = acpPeer()
  const firstBoot: FakeTransport[] = []
  const first = await createFakeWorkspaceApp({ connections: connections(peer, firstBoot) })
  for (const connectionId of ["pi", "codex", "scripted-acp"]) await first.createSession(`ses_${connectionId}`, {}, { connectionId })
  const goal: RuntimeGoalSnapshot = { sessionId: "ses_codex", objective: "Ship the fix", status: "paused", createdAt: 1, updatedAt: 2 }
  first.store().setGoal("ses_codex", goal)
  await first.dispose({ keepRoot: true })
  expect(peer.peers).toHaveLength(1)

  const fakes: FakeTransport[] = []
  const reopened = await createFakeWorkspaceApp({ root: first.root, connections: connections(peer, fakes) })
  apps.push(reopened)
  const open = async (sessionId: string) => {
    const response = await reopened.app.request(reopened.url(`/session/${sessionId}`, { view: "open" }))
    expect(response.status).toBe(200)
    return await response.json() as Record<string, { value?: unknown; error?: { status: number; code?: string } }>
  }

  const pi = await open("ses_pi")
  expect(pi.todos).toEqual({ error: expect.objectContaining({ status: 409, code: "unsupported_operation" }) })
  expect(pi.goal).toEqual({ value: expect.objectContaining({ capabilities: expect.objectContaining({ implemented: false }), goal: null }) })

  const codex = await open("ses_codex")
  expect(codex.todos).toEqual({ value: [] })
  expect(codex.goal).toEqual({ value: expect.objectContaining({ capabilities: expect.objectContaining({ implemented: true }), goal }) })

  const acp = await open("ses_scripted-acp")
  expect(acp.todos).toEqual({ value: [] })
  expect(acp.goal).toEqual({ value: expect.objectContaining({ goal: null }) })

  for (const view of [pi, codex, acp]) {
    for (const fact of ["status", "permissions", "questions", "subagents"]) expect(view[fact], fact).toHaveProperty("value")
  }
  expect(fakes.flatMap((transport) => [...transport.attaches, ...transport.starts])).toEqual([])
  expect(peer.peers).toHaveLength(1)
})
