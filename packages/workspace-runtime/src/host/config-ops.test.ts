import { afterEach, describe, expect, test } from "bun:test"
import { HARNESS_TABLE, type AgentPermissionMode, type AgentPermissionModeState, type PromptModel, type SessionHarness } from "@claxedo/agent-runtime-contract"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { PermissionModeRefusedError } from "@claxedo/agent-sdk-runtime"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"
import type { ConfigPreviewTarget, HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"
import type { AgentRuntimeStore } from "./contracts"
import type { HarnessHandle } from "./transports"
import { createHarnessReads } from "./config-ops"

test("runtime-owned previews read the current saved model on every request", async () => {
  let model: PromptModel | undefined = { providerID: "proof", modelID: "first" }
  const calls: ConfigPreviewTarget[] = []
  const handle = { transport: {
    capabilities: async () => ({ configOwner: "runtime" }),
    config: { options: async (target: ConfigPreviewTarget) => { calls.push(target); return { options: [] } } },
  } as unknown as HarnessTransport } as HarnessHandle
  const session: HarnessSession = { directory: "/tmp", locality: "local", binding: {
    sessionId: "session", workspaceId: "workspace", upstreamSessionId: "upstream", directory: "/tmp", connectionId: "opencode",
  } }
  const reads = createHarnessReads({
    store: { getSessionConfig: () => ({ harness: { id: "opencode", access: "native" }, model }) } as unknown as AgentRuntimeStore,
    attachments: { for: async () => ({ handle, session }) } as unknown as SessionAttachments,
    transports: { forHarness: async () => handle, composed: () => [handle], onRetire: () => () => {} },
    savedCommands: () => [],
    writeRow: (_sessionId, write) => write(),
    launch: { workspaceId: "workspace", credentials: () => ({ placement: "loopback", machineOwnerUserId: "fixture", canUseOwnLogin: true, accounts: {}, leaseGeneration: "one" }),
      projection: () => ({ generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] }) },
  })
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session, model })
  model = { providerID: "proof", modelID: "second" }
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session, model })
  await reads.configOptions({ sessionId: "session" }, "preview")
  expect(calls.at(-1)).toEqual({ session, model: { providerID: "proof", modelID: "preview" } })
  model = undefined
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session })
})

const CLAUDE: SessionHarness = { id: "claude", access: "native" }
const LISTED: SessionHarness = { id: "pi", access: "native" }
const AGENT_MODES: AgentPermissionMode[] = [
  { id: "ask", name: "Ask every time" },
  { id: "code", name: "Write code" },
]

function modeConfig(modes: readonly AgentPermissionMode[], keeps: (modeId: string) => string = (modeId) => modeId) {
  let current: string | undefined
  const state = (): AgentPermissionModeState => ({ modes: [...modes], ...(current ? { currentModeId: current } : {}), appliesFrom: "next-turn" })
  return {
    read: async () => { throw new Error("runtime-owned") },
    update: async () => { throw new Error("runtime-owned") },
    options: async () => ({ options: [] }),
    permissionModes: async () => state(),
    setPermissionMode: async (_session: unknown, modeId: string) => {
      current = keeps(modeId)
      return state()
    },
  }
}

describe("a selection write publishes the session's row", () => {
  const fixtures: HostFixture[] = []
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose()
  })

  async function hostWith(harness: SessionHarness, transport: FakeTransport, others: Record<string, FakeTransport> = {}) {
    const fixture = createHostFixture({ transports: { ...others, [harness.id]: transport } })
    fixtures.push(fixture)
    const published: CompatEnvelope[] = []
    fixture.eventHub.subscribeGlobal((event) => {
      if (event.payload.type === "session.updated") published.push(event)
    })
    const session = await fixture.runtime.sessions.create(sessionCreate({ id: "ses_row", harness }))
    published.splice(0)
    return { fixture, published, sessionId: session.id }
  }

  const rowConfig = (event: CompatEnvelope | undefined) =>
    (event?.payload.properties as { info?: { config?: Record<string, unknown> } } | undefined)?.info?.config

  test("a mode write publishes the row once with the kept mode, and the same write again publishes nothing", async () => {
    const { fixture, published, sessionId } = await hostWith(CLAUDE, new FakeTransport({ config: modeConfig(HARNESS_TABLE.claude.permissionModes.modes) }))

    const kept = await fixture.runtime.reads.setPermissionMode(sessionId, "plan")
    expect(kept.currentModeId).toBe("plan")
    expect(published).toHaveLength(1)
    expect(published[0].directory).toBe("/repo")
    expect(rowConfig(published[0])).toMatchObject({ permissionMode: "plan" })
    expect(rowConfig(published[0])).not.toHaveProperty("permissionModeLabel")

    await fixture.runtime.reads.setPermissionMode(sessionId, "plan")
    expect(published).toHaveLength(1)
  })

  test("a harness that lists its own modes stores the mode it kept under the name it listed", async () => {
    const { fixture, published, sessionId } = await hostWith(LISTED, new FakeTransport({ config: modeConfig(AGENT_MODES, () => "code") }))

    const kept = await fixture.runtime.reads.setPermissionMode(sessionId, "ask")

    expect(kept.currentModeId).toBe("code")
    expect(rowConfig(published.at(-1))).toMatchObject({ permissionMode: "code", permissionModeLabel: "Write code" })
    expect(fixture.store.getSessionConfig(sessionId)).toMatchObject({ permissionMode: "code", permissionModeLabel: "Write code" })
  })

  test("a model change through updateConfig publishes the row, and an unchanged one publishes nothing", async () => {
    const { fixture, published, sessionId } = await hostWith(CLAUDE, new FakeTransport())
    const model = { providerID: "anthropic", modelID: "claude-next" }

    await fixture.runtime.sessions.updateConfig(sessionId, { model })
    expect(published).toHaveLength(1)
    expect(rowConfig(published[0])).toMatchObject({ model })

    await fixture.runtime.sessions.updateConfig(sessionId, { model })
    expect(published).toHaveLength(1)
  })

  test("a harness switch publishes the row on its new harness", async () => {
    const { fixture, published, sessionId } = await hostWith(CLAUDE, new FakeTransport(), { pi: new FakeTransport() })

    await fixture.runtime.sessions.updateConfig(sessionId, { harness: LISTED })

    expect(published).toHaveLength(1)
    expect(rowConfig(published[0])).toMatchObject({ harness: LISTED })
  })

  test("a mode the harness does not offer and a harness with no modes are refused by type, and nothing is stored", async () => {
    const offered = await hostWith(CLAUDE, new FakeTransport({ config: modeConfig(HARNESS_TABLE.claude.permissionModes.modes) }))
    const unknown = await offered.fixture.runtime.reads.setPermissionMode(offered.sessionId, "yolo").catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(PermissionModeRefusedError)
    expect(unknown).toMatchObject({ code: "unknown_permission_mode" })
    expect(offered.fixture.store.getSessionConfig(offered.sessionId)?.permissionMode).toBeUndefined()

    const none = await hostWith(LISTED, new FakeTransport())
    const unsupported = await none.fixture.runtime.reads.setPermissionMode(none.sessionId, "ask").catch((error: unknown) => error)
    expect(unsupported).toBeInstanceOf(PermissionModeRefusedError)
    expect(unsupported).toMatchObject({ code: "permission_modes_unsupported" })
    expect(offered.published).toHaveLength(0)
    expect(none.published).toHaveLength(0)
  })
})
