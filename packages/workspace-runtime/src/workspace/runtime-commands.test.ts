import { afterEach, expect, test } from "bun:test"
import { createFakeWorkspaceApp, type FakeWorkspaceApp } from "../test-support/fake-workspace-app"
import type { RuntimeSnapshot } from "../routes/config"

const apps: FakeWorkspaceApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
})

function snapshot(commands: RuntimeSnapshot["commands"]): RuntimeSnapshot {
  return {
    version: 4, auth: {}, mcp: {}, commands,
    connections: [{ connectionId: "fake", providerKey: "fake", configRevision: 1, enabled: true, config: {} }],
    defaultHarness: { kind: "connection", connectionId: "fake" },
  }
}

async function fixture(commands?: { list(): Promise<Array<{ name: string; description: string }>> }) {
  const app = await createFakeWorkspaceApp({ fakeTransport: commands ? { commands } : {} })
  apps.push(app)
  return app
}

async function read(app: FakeWorkspaceApp) {
  const response = await app.app.request(app.url("/command"))
  expect(response.status).toBe(200)
  return response.json()
}

test("snapshot commands and transport commands retain their contents and origins through update and removal", async () => {
  const app = await fixture({ list: async () => [{ name: "review", description: "Harness review" }] })
  const push = (commands: RuntimeSnapshot["commands"]) => app.host.apply(snapshot(commands))
  await push([{ name: "review", content: "User review $ARGUMENTS" }])
  await app.createSession("before-update")
  expect(await read(app)).toEqual([
    { name: "review", content: "User review $ARGUMENTS", origin: "saved" },
    { name: "review", description: "Harness review", origin: "transport" },
  ])
  await push([{ name: "triage", content: "Updated command" }])
  expect(await read(app)).toEqual([
    { name: "triage", content: "Updated command", origin: "saved" },
    { name: "review", description: "Harness review", origin: "transport" },
  ])
  await push([])
  expect(await read(app)).toEqual([{ name: "review", description: "Harness review", origin: "transport" }])
})

test("saved commands work without transport commands and never leak to another runtime", async () => {
  const first = await fixture()
  const second = await fixture()
  await first.host.apply(snapshot([{ name: "private", content: "First workspace" }]))
  expect(await read(first)).toEqual([{ name: "private", content: "First workspace", origin: "saved" }])
  expect(await read(second)).toEqual([])
  await expect(first.host.apply(snapshot([{ name: "invalid", content: 7 as never }]))).rejects.toThrow("Invalid runtime config snapshot")
  expect(await read(first)).toEqual([{ name: "private", content: "First workspace", origin: "saved" }])
})

test("transport listing failure does not return a partial successful command list", async () => {
  const app = await fixture({ list: async () => { throw new Error("transport commands unavailable") } })
  await app.host.apply(snapshot([{ name: "triage", content: "User triage" }]))
  const response = await app.app.request(app.url("/command"))
  expect(response.status).toBe(500)
})

test("a plugin launch apply keeps the saved commands", async () => {
  const app = await fixture()
  await app.host.apply(snapshot([{ name: "triage", content: "Triage" }]))
  await app.host.applyHarnessLaunch({})
  expect(await read(app)).toEqual([{ name: "triage", content: "Triage", origin: "saved" }])
})
