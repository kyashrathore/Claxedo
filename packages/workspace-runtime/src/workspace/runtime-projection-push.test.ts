import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StartInput, TransportConfigUpdate } from "@claxedo/harness/contract"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import type { RuntimeSnapshot } from "../routes/config"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"

/**
 * What a config push leaves a live session holding.
 *
 * The snapshot keys its projections by registry provider id (`cursor-sdk`,
 * `claude-sdk`, `codex-app-server`) and every transport reads them that way. A
 * second, slot-shaped path beside it can only disagree, and when it disagrees
 * the harness runs on whatever login the machine holds — which is the one
 * outcome the operator's account selection exists to prevent.
 */
let directory = ""
/** Fixed so two snapshots differ by exactly what a test changed. */
const EXPIRES_AT = Date.now() + 60 * 60 * 1000

function snapshot(overrides: Partial<RuntimeSnapshot> = {}, baseUrl = "http://127.0.0.1:2595/bindings/cursor1"): RuntimeSnapshot {
  return {
    version: 4,
    mcp: {},
    connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
    auth: {
      "cursor-sdk": {
        baseUrl,
        placeholder: "cursor-placeholder",
        authMode: "bearer",
        expiresAt: EXPIRES_AT,
      },
    },
    ...overrides,
  }
}

const selected = { defaultHarness: { kind: "connection", connectionId: "fixture" } } as const

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-projection-"))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

function runtimeApp() {
  const starts: StartInput[] = []
  const configures: TransportConfigUpdate[] = []
  const transport = new FakeTransport({
    onStart: (start) => { starts.push(start) },
    configure: (update) => { configures.push(update); return { state: "applied" } },
  })
  const target = { workspaceId: "ws_1", directory }
  const runtime = createWorkspaceRuntimeApp({
    placement: loopbackMachineLoginPolicy(),
    target,
    storeRoot: directory,
    harnessStateRoot: path.join(directory, "harness"),
    exposure: loopbackWorkspaceRuntimeExposure(),
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })],
  })
  const createSession = (id: string) => withWorkspaceTarget(target, () => runtime.app.request(
    `http://runtime.test/session?directory=${encodeURIComponent(directory)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) },
  ))
  return { runtime, starts, configures, createSession }
}

test("a session starts on the projection under its registry id", async () => {
  const f = runtimeApp()
  try {
    await f.runtime.host.apply(snapshot(selected))
    expect((await f.createSession("s1")).status).toBe(201)
    expect(f.starts[0]?.credentials.providers).toEqual({ "cursor-sdk": expect.objectContaining({ baseUrl: "http://127.0.0.1:2595/bindings/cursor1" }) })
  } finally {
    await f.runtime.host.dispose()
  }
})

test("a push that selects no harness leaves the live session's binding alone", async () => {
  const f = runtimeApp()
  try {
    await f.runtime.host.apply(snapshot(selected))
    expect((await f.createSession("s1")).status).toBe(201)

    // Same projections, no harness named. The session is still live and still
    // bound; nothing here says otherwise.
    await f.runtime.host.apply(snapshot())

    expect(f.configures).toEqual([])
  } finally {
    await f.runtime.host.dispose()
  }
})

test("a snapshot carrying an unreadable projection leaves the binding already in force", async () => {
  const f = runtimeApp()
  try {
    await f.runtime.host.apply(snapshot(selected))
    expect((await f.createSession("s1")).status).toBe(201)

    const rejected = {
      ...snapshot(selected),
      auth: { "cursor-sdk": { baseUrl: "", placeholder: "", authMode: "bearer", expiresAt: 0 } },
    } as unknown as RuntimeSnapshot
    await expect(f.runtime.host.apply(rejected)).rejects.toThrow("Invalid runtime config snapshot")

    expect(f.configures).toEqual([])
  } finally {
    await f.runtime.host.dispose()
  }
})

test("a changed projection reaches each live session once, under its registry id", async () => {
  const f = runtimeApp()
  try {
    await f.runtime.host.apply(snapshot(selected))
    expect((await f.createSession("s1")).status).toBe(201)

    await f.runtime.host.apply(snapshot(selected, "http://127.0.0.1:2595/bindings/cursor2"))

    // Once, and by registry provider id: a second delivery path keyed by
    // harness slot would disagree with this one about every brokered account.
    expect(f.configures).toHaveLength(1)
    expect(f.configures[0]?.credentials?.providers).toEqual({ "cursor-sdk": expect.objectContaining({ baseUrl: "http://127.0.0.1:2595/bindings/cursor2" }) })
  } finally {
    await f.runtime.host.dispose()
  }
})
