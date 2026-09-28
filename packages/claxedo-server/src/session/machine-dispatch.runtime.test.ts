import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createWorkspaceRuntimeApp, loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"
import { FakeTransport, fakeConnectionProvider, loopbackMachineLoginPolicy } from "@claxedo/workspace-runtime/testing"
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import { createMachineSessionDispatch } from "./machine-dispatch"
import type { ControlPlaneServices } from "../authority/services"

let directory = "/workspace"
const workspace = { id: "ws_machine", kind: "local", get directory() { return directory }, org_id: "org" }

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: async ({ workspaceId }: { workspaceId: string }) => (workspaceId === "ws_machine" ? workspace : undefined),
}))

const CONNECTION = "machine-fixture"

/** A harness whose one reply is "machine reply"; the runtime projects it into the transcript frames the dispatch reads. */
function fixtureTransport() {
  return new FakeTransport({
    capabilities: { instructionChannel: "none" },
    turn: async function* ({ session }) {
      yield { type: "text-delta", delta: "machine reply" }
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
}

let disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  configureLocalWorkspaceRuntime(undefined)
  for (const dispose of disposers.splice(0)) await dispose()
})

describe("machine dispatch against the workspace runtime it reads", () => {
  test("a dispatched prompt's turn is read off wr/events, session-scoped, through the embedded runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-machine-dispatch-"))
    directory = path.join(root, "workspace")
    await fs.mkdir(directory)
    const runtime = createWorkspaceRuntimeApp({
      exposure: loopbackWorkspaceRuntimeExposure(),
      placement: loopbackMachineLoginPolicy(),
      target: { workspaceId: "ws_machine", directory },
      storeRoot: path.join(root, "state"),
      connectionProviders: [fakeConnectionProvider({ providerKey: CONNECTION, transport: fixtureTransport })],
    })
    disposers.push(async () => {
      await runtime.dispose()
      await fs.rm(root, { recursive: true, force: true })
    })
    await runtime.host.apply({
      version: 4,
      commands: [],
      mcp: {},
      auth: {},
      connections: [{ connectionId: CONNECTION, providerKey: CONNECTION, configRevision: 1, enabled: true, config: {} }],
      defaultHarness: { kind: "connection", connectionId: CONNECTION },
    })
    configureLocalWorkspaceRuntime({
      fetch: async (_ws, request) => await runtime.app.fetch(request),
      sessionAuthority: () => "local",
    })

    const services = {
      projectionStore: {
        session_meta: async () => ({ host: "workspace", workspaceID: "ws_machine" }),
        put_session_meta: async () => {},
      },
    } as unknown as ControlPlaneServices
    const dispatch = createMachineSessionDispatch(services, {})
    const session = await dispatch.create({ workspaceId: "ws_machine" })
    expect(session.id).toMatch(/^ses_/)

    const seen: Array<{ type: string; properties?: { part?: { text?: string } } }> = []
    for await (const event of dispatch.prompt(session.id, { messageID: "msg_machine", parts: [{ type: "text", text: "hi" }] })) {
      seen.push(event as (typeof seen)[number])
    }
    expect(seen.map((event) => event.type)).toContain("message.updated")
    expect(seen.some((event) => event.type === "message.part.updated" && event.properties?.part?.text === "machine reply")).toBe(true)
    expect(seen.at(-1)?.type).toBe("session.idle")
  })
})
