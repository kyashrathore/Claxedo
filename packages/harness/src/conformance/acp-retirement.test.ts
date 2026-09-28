import { expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpTransport } from "../transports/acp"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { createSessionBroker } from "../broker"
import { authority, origin } from "./test-support/memory-ports"
import { setupConformance } from "./test-support/run"

type Exited = Promise<{ code: number | null; signal: string | null }>
type RetirePolicy = (child: ChildProcess, exited: Exited, index: number) => Promise<{ stopped: true } | { stopped: false; error: { code: "deadline"; message: string } }>

const stop = async (child: ChildProcess, exited: Exited) => {
  child.kill("SIGTERM")
  await exited
  return { stopped: true as const }
}

async function refusingFirstRetirement() {
  const state = { attempts: 0 }
  return { ...await retirementFixture(async (child, exited) => {
    if (++state.attempts === 1) return { stopped: false, error: { code: "deadline", message: "Retirement refused" } }
    return await stop(child, exited)
  }), state }
}

async function retirementFixture(retirePeer: RetirePolicy) {
  const directory = await mkdtemp(join(tmpdir(), "acp-retirement-"))
  const children: ChildProcess[] = []
  const context = await setupConformance({ name: "ACP retirement",
    backend: async () => ({ directory, harness: { id: "acp", access: "connection" },
      model: { providerID: "acp", modelID: "default" }, owner: { kind: "machine-owner" },
      credentials: { providers: {}, secrets: {}, leaseGeneration: "one" }, unrunnableTurn: (turn) => turn,
      close: () => rm(directory, { recursive: true, force: true }),
      configureServices(services) {
        services.spawn = async (command) => {
          const child = spawn(command.file, [...command.args], { cwd: command.cwd, env: command.env, stdio: "pipe" })
          const index = children.push(child) - 1
          const exited: Exited = new Promise((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }))
          })
          return { pid: child.pid!, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
            retire: () => retirePeer(child, exited, index) }
        }
      },
    }),
    makeTransport: (services) => new AcpTransport(services, { kind: "process", command: process.execPath,
      args: [join(import.meta.dirname, "../../e2e/harness/acp/agent.ts")], env: { SCRIPTED_ACP_DIR: directory } },
      filterMcpServers, async () => { throw new Error("Unexpected restore") }),
  })
  const live = () => children.filter((child) => child.exitCode === null && child.signalCode === null)
  const release = async () => {
    for (const child of live()) child.kill("SIGKILL")
    await context.close()
  }
  return { context, live, release }
}

for (const failed of ["dispose", "close"] as const) test(`ACP dispose retries a peer whose ${failed} retirement failed`, async () => {
  const { context, state, live, release } = await refusingFirstRetirement()
  try {
    expect(live()).toHaveLength(1)
    const first = failed === "close" ? context.transport.close(context.session) : context.transport.dispose()
    await expect(first).rejects.toThrow("Retirement refused")
    expect(live()).toHaveLength(1)
    await context.transport.dispose()
    expect(state.attempts).toBe(2)
    expect(live()).toHaveLength(0)
    await context.transport.dispose()
    expect(state.attempts).toBe(2)
  } finally { await release() }
}, 30_000)

test("ACP dispose waits for every peer's retirement before reporting the one that failed", async () => {
  let releaseSlow!: () => void
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  let slowStopped = false
  let refusals = 1
  const { context, live, release } = await retirementFixture(async (child, exited, index) => {
    if (index === 0 && refusals-- > 0) return { stopped: false, error: { code: "deadline", message: "Retirement refused" } }
    if (index === 0) return await stop(child, exited)
    await slow
    const stopped = await stop(child, exited)
    slowStopped = true
    return stopped
  })
  try {
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: context.backend.directory })
    context.ports.directories.set("s2", context.backend.directory)
    await context.transport.start({ ...context.start, sessionId: "s2", workspaceId: "w2" }, createSessionBroker(context.owner,
      { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin }))
    expect(live()).toHaveLength(2)
    let settled = false
    const disposal = context.transport.dispose().then(() => undefined, (error: unknown) => error).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    releaseSlow()
    expect(await disposal).toMatchObject({ code: "ownership", message: "Retirement refused" })
    expect(slowStopped).toBe(true)
  } finally { releaseSlow(); await release() }
}, 30_000)
