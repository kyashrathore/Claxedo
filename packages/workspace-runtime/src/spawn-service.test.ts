import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createSpawnService } from "./spawn-service"

function processExists(pid: number) {
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim()
    return state.length > 0 && !state.startsWith("Z")
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return false
    throw error
  }
}

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

test("spawn observes output and retires the child and its descendant", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harness-spawn-"))
  const ownership = volatileLaunchOwnership()
  let owned: Awaited<ReturnType<ReturnType<typeof createSpawnService>>> | undefined
  try {
    owned = await createSpawnService(ownership)({
      file: "/bin/sh",
      args: ["-c", "sleep 30 & child=$!; printf 'CHILD:%s\\n' \"$child\"; wait"],
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, { role: "harness", label: "descendant proof", sessionId: "spawn-test" })
    const output = await waitForOutput(owned.stdout, /CHILD:(\d+)/)
    const descendant = Number(output.match(/CHILD:(\d+)/)?.[1])
    expect(descendant).toBeGreaterThan(0)
    expect(processExists(owned.pid)).toBe(true)
    expect(processExists(descendant)).toBe(true)

    const retired = await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    expect(retired).toEqual({ stopped: true })
    await owned.exited
    expect(processExists(owned.pid)).toBe(false)
    expect(processExists(descendant)).toBe(false)
    expect(await ownership.listUnresolved({ kind: "standalone", sessionId: "spawn-test" })).toEqual([])
  } finally {
    if (owned) await owned.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })
    await rm(cwd, { recursive: true, force: true })
  }
})
