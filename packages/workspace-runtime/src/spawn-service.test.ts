import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createSpawnService } from "./spawn-service"

/** A zombie is not a running process; `ps` is the only POSIX read that tells the two apart, and Windows has neither. */
function processExists(pid: number) {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim()
    return state.length > 0 && !state.startsWith("Z")
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return false
    throw error
  }
}

/** The payloads are this runtime's own executable, which every platform can spawn without a shell. */
const script = (source: string) => ({ file: process.execPath, args: ["-e", source] })

async function waitForOutput(stream: NodeJS.ReadableStream, pattern: RegExp): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern} in ${output}`)), 5_000)
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      if (!pattern.test(output)) return
      clearTimeout(timeout)
      resolve(output)
    })
    stream.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

test("spawn refuses an already-aborted signal and leaves no launch unresolved", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harness-spawn-abort-"))
  const ownership = volatileLaunchOwnership()
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(createSpawnService(ownership)({
      ...script("process.exit(0)"),
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, { role: "harness", label: "aborted proof", sessionId: "spawn-abort", signal: controller.signal })).rejects.toThrow("aborted")
    expect(await ownership.listUnresolved({ kind: "standalone", sessionId: "spawn-abort" })).toEqual([])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("spawn observes output and retires the child and its descendant", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harness-spawn-"))
  const ownership = volatileLaunchOwnership()
  let owned: Awaited<ReturnType<ReturnType<typeof createSpawnService>>> | undefined
  try {
    owned = await createSpawnService(ownership)({
      ...script(`const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)"]); console.log("CHILD:" + child.pid); child.exited.then((code) => process.exit(code))`),
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, { role: "harness", label: "descendant proof", signal: new AbortController().signal, sessionId: "spawn-test" })
    const output = await waitForOutput(owned.stdout, /CHILD:(\d+)/)
    const descendant = Number(output.match(/CHILD:(\d+)/)?.[1])
    expect(descendant).toBeGreaterThan(0)
    expect(processExists(owned.pid)).toBe(true)
    expect(processExists(descendant)).toBe(true)

    const first = owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    const concurrent = owned.retire({ at: Date.now() - 1, signal: new AbortController().signal })
    expect(concurrent).toBe(first)
    const retired = await first
    expect(retired).toEqual({ stopped: true })
    expect(owned.retire({ at: Date.now() - 1, signal: new AbortController().signal })).toBe(first)
    await owned.exited
    expect(processExists(owned.pid)).toBe(false)
    expect(processExists(descendant)).toBe(false)
    expect(await ownership.listUnresolved({ kind: "standalone", sessionId: "spawn-test" })).toEqual([])
  } finally {
    if (owned) await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    await rm(cwd, { recursive: true, force: true })
  }
})

test("a retirement refused for an expired deadline can be retried and stops the process", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harness-spawn-retry-"))
  const ownership = volatileLaunchOwnership()
  let owned: Awaited<ReturnType<ReturnType<typeof createSpawnService>>> | undefined
  try {
    owned = await createSpawnService(ownership)({
      ...script(`console.log("READY"); setTimeout(() => {}, 30_000)`),
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, { role: "harness", label: "retry proof", signal: new AbortController().signal, sessionId: "spawn-retry" })
    await waitForOutput(owned.stdout, /READY/)
    const refused = await owned.retire({ at: Date.now() - 1, signal: new AbortController().signal })
    expect(refused).toMatchObject({ stopped: false, error: { code: "deadline_exceeded" } })
    expect(processExists(owned.pid)).toBe(true)
    expect(await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })).toEqual({ stopped: true })
    await owned.exited
    expect(processExists(owned.pid)).toBe(false)
  } finally {
    if (owned) await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    await rm(cwd, { recursive: true, force: true })
  }
})

test("spawn scrubs the runtime's internal secrets from every harness environment", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harness-spawn-env-"))
  const ownership = volatileLaunchOwnership()
  let owned: Awaited<ReturnType<ReturnType<typeof createSpawnService>>> | undefined
  try {
    owned = await createSpawnService(ownership)({
      ...script(`console.log("ENV:" + ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", "CLAXEDO_SERVER_URL", "HARNESS_PLAIN"].map((name) => process.env[name] ?? "unset").join("|"))`),
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "private-key-material",
        CLAXEDO_SERVER_URL: "http://127.0.0.1:4100",
        HARNESS_PLAIN: "kept",
      },
    }, { role: "harness", label: "env scrub", signal: new AbortController().signal, sessionId: "spawn-env-test" })
    const output = await waitForOutput(owned.stdout, /ENV:.*\n/)
    expect(output).toContain("ENV:unset|http://127.0.0.1:4100|kept")
    await owned.exited
  } finally {
    if (owned) await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    await rm(cwd, { recursive: true, force: true })
  }
})

