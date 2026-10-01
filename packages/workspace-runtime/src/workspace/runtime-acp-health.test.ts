import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"

test("a runtime whose default harness is an ACP connection is healthy before and after its sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-acp-health-"))
  const target = { workspaceId: "acp-health", directory }
  const peerPath = fileURLToPath(new URL("./fixtures/acp-startup-peer.mjs", import.meta.url))
  const runtime = createWorkspaceRuntimeApp({
  sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), exposure: loopbackWorkspaceRuntimeExposure(), target, storeRoot: join(directory, "store") })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => runtime.app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  try {
    await runtime.host.apply({ version: 4, commands: [], auth: { machineOwnerUserId: "local", accounts: {} }, mcp: {}, connections: [{ connectionId: "health-agent", providerKey: "acp", configRevision: 1, enabled: true,
      config: { label: "Health agent", connection: { kind: "process", command: "node", args: [peerPath] } } }], defaultHarness: { kind: "connection", connectionId: "health-agent" } })
    expect(await (await request("/global/health")).json()).toMatchObject({ ok: true })
    const creating = request("/session?connectionId=health-agent", "POST", { id: "health-session" })
    let questions: Array<{ id: string }> = []
    for (let n = 0; n < 400 && !questions.length; n++) {
      questions = await (await request("/question?sessionId=health-session")).json()
      if (!questions.length) await Bun.sleep(5)
    }
    expect((await request(`/question/${questions[0]?.id}/reply`, "POST", { answers: [[JSON.stringify({ label: "ok" })]] })).status).toBe(200)
    expect((await creating).status).toBe(201)
    expect((await request("/session/health-session", "DELETE")).status).toBe(200)
    expect(await (await request("/global/health")).json()).toMatchObject({ ok: true })
    expect(runtime.host.detail().connectionState).toMatchObject({ connectionId: "health-agent", state: "configured", processes: [] })
  } finally { await runtime.host.dispose(); await rm(directory, { recursive: true, force: true }) }
})
