import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

test("sessions created through the API without a prompt, naming their harness in the body as the app does, run one agent each and hold none once their creation answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-acp-idle-"))
  const target = { workspaceId: "idle-workspace", directory }
  const logFile = join(directory, "peer.jsonl")
  const peer = fileURLToPath(new URL("./fixtures/acp-recovery-peer.mjs", import.meta.url))
  const config = { version: 4 as const, commands: [], auth: { machineOwnerUserId: "local", accounts: { local: {} } }, mcp: {}, connections: [{ connectionId: "idle", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Idle peer", connection: { kind: "process", command: "node", args: [peer, logFile, "resume"] } } }], defaultHarness: { kind: "connection" as const, connectionId: "idle" } }
  const host = createWorkspaceHost({ sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "store") })
  await host.apply(config)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  try {
    const titles = Array.from({ length: 12 }, (_, index) => `Bulk ${index}`)
    const created = await Promise.all(titles.map((title) => request("/session", "POST", { title, harness: { id: "idle", access: "connection" } })))
    expect(created.map((response) => response.status)).toEqual(titles.map(() => 201))
    const log = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method?: string })
    const pids = [...new Set(log.map((row) => row.pid))]
    expect(pids, "one agent per creation").toHaveLength(titles.length)
    for (let n = 0; n < 400 && pids.some(alive); n++) await Bun.sleep(5)
    expect(pids.filter(alive), "agent processes still alive after their sessions' creation answered").toEqual([])
    expect((await request("/session")).status).toBe(200)
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 20_000)
