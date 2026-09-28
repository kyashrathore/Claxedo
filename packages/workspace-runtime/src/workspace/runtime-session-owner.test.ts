import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StartInput } from "@claxedo/harness/contract"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { withWorkspaceTarget } from "../target"

let directory = ""

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-session-owner-"))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

test("a connected host's snapshot names its machine owner over the placement's, so the owner's session spends their account", async () => {
  const starts: StartInput[] = []
  const transport = new FakeTransport({ onStart: (start) => { starts.push(start) } })
  const target = { workspaceId: "ws_1", directory }
  const runtime = createWorkspaceRuntimeApp({
    placement: { placement: "desktop", machineOwnerUserId: "", canUseOwnLogin: true },
    target,
    storeRoot: directory,
    harnessStateRoot: path.join(directory, "harness"),
    exposure: loopbackWorkspaceRuntimeExposure(),
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })],
  })
  try {
    const binding = { baseUrl: "http://127.0.0.1:2595/bindings/owner", placeholder: "owner-placeholder", authMode: "bearer" as const }
    await runtime.host.apply({
      version: 4,
      commands: [],
      mcp: {},
      connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
      defaultHarness: { kind: "connection", connectionId: "fixture" },
      auth: { machineOwnerUserId: "usr_owner", accounts: { usr_owner: { "cursor-sdk": binding } } },
    })
    const created = await withWorkspaceTarget(target, () => runtime.app.request(
      `http://runtime.test/session?directory=${encodeURIComponent(directory)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "owned" }) },
    ))
    expect(created.status, await created.clone().text()).toBe(201)
    expect(starts[0]?.credentials).toMatchObject({
      accountOwner: "usr_owner",
      machineLoginAllowed: true,
      providers: { "cursor-sdk": binding },
    })
  } finally {
    await runtime.host.dispose()
  }
})
