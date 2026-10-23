import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ownedExecutionEnv, resolvedPiShell, RUNNER_RESTARTED_NOTICE, sessionCommands } from "@claxedo/harness/pi-durable/shell"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { requirePiRunner } from "./host/executables/pi-runner"
import { createSpawnService } from "./spawn-service"

const shell = resolvedPiShell(process.env)
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function processExists(pid: number) {
  if (process.platform === "win32") {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  try { return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z") }
  catch { return false }
}

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

async function session(name: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), `pi-shell-host-${name}-`))
  const services = { spawn: createSpawnService(volatileLaunchOwnership()), clock: { now: Date.now, setTimeout, clearTimeout }, log: silent }
  const commands = sessionCommands(services, () => requirePiRunner(process.env), env)
  const runner = commands.of(`ses_${name}`, cwd)
  const exec = ownedExecutionEnv({ sessionId: `ses_${name}`, services, env, runner, shell }, cwd)
  const run = async (command: string, onOutput?: (text: string) => void) => exec.exec(command, { onOutput: (text) => onOutput?.(text), timeout: 60 }, BACKGROUND_CONTEXT)
  return { cwd, run, runner, close: async () => { await commands.retireAll(); await rm(cwd, { recursive: true, force: true }) } }
}

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const nodeScript = (source: string) => `${quoted(process.execPath)} -e ${quoted(source)}`

test.skipIf(!shell)("a background process a command starts outlives it, answers a later command of the session, and ends when the session closes", async () => {
  const { cwd, run, close } = await session("outlive")
  const pidFile = path.join(cwd, "bg.pid")
  try {
    const started = await run(`(${nodeScript(`require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`)} ${quoted(pidFile)} > /dev/null 2>&1 &); echo started`)
    expect(started).toEqual({ ok: true, value: { exitCode: 0 } })
    expect(await until(() => { try { return Number(require("node:fs").readFileSync(pidFile, "utf8")) > 0 } catch { return false } }, 10_000)).toBe(true)
    const pid = Number(await readFile(pidFile, "utf8"))

    const seen: string[] = []
    const later = await run(`${nodeScript(`process.stdout.write(String(process.argv[1]))`)} ${pid}`, (text) => { seen.push(text) })
    expect(later).toEqual({ ok: true, value: { exitCode: 0 } })
    expect(seen.join("")).toBe(String(pid))
    expect(processExists(pid), "the background process is still there after a later command").toBe(true)

    await close()
    expect(await until(() => !processExists(pid), 10_000), "closing the session ended it").toBe(true)
  } finally {
    const leftover = Number(await readFile(pidFile, "utf8").catch(() => "0"))
    if (leftover > 0 && processExists(leftover)) process.kill(leftover, "SIGKILL")
    await close()
  }
}, 60_000)

test.skipIf(!shell)("a shell host killed between two commands fails nothing silently: the next command starts a new host and says so first", async () => {
  const { run, runner, close } = await session("crash")
  try {
    expect(await run("echo one")).toEqual({ ok: true, value: { exitCode: 0 } })
    const pid = runner.pid
    expect(pid).toBeGreaterThan(0)
    process.kill(pid!, "SIGKILL")
    expect(await until(() => !processExists(pid!), 10_000)).toBe(true)

    const seen: string[] = []
    const next = await run("echo two", (text) => { seen.push(text) })
    expect(next).toEqual({ ok: true, value: { exitCode: 0 } })
    expect(seen.join("")).toBe(`${RUNNER_RESTARTED_NOTICE}\ntwo\n`)
    expect(runner.pid).not.toBe(pid)
  } finally {
    await close()
  }
}, 60_000)

test.skipIf(!shell)("a command printing 50 MB streams through the host without stalling a command beside it", async () => {
  const { run, close } = await session("large")
  try {
    let bytes = 0
    const large = run(nodeScript(`const chunk = Buffer.alloc(1 << 20, 120); let left = 50; const write = () => { while (left > 0) { left--; if (!process.stdout.write(chunk)) { process.stdout.once("drain", write); return } } }; write()`), (text) => { bytes += Buffer.byteLength(text) })
    const small = await Promise.race([
      run("echo small").then((result) => ({ result })),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 20_000)),
    ])
    expect(small).toEqual({ result: { ok: true, value: { exitCode: 0 } } })
    expect(await large).toEqual({ ok: true, value: { exitCode: 0 } })
    expect(bytes).toBe(50 * (1 << 20))
  } finally {
    await close()
  }
}, 120_000)
