import { afterEach, describe, expect, test } from "bun:test"
import type { spawn as spawnReal } from "child_process"
import { EventEmitter } from "events"
import fs from "fs"
import os from "os"
import path from "path"
import { OpenCodeServerProcess, redact } from "./process"

const inputs = { config: () => ({}), auth: () => ({}) }

/**
 * A spawned `opencode serve`, minus the process.
 *
 * The adapter only ever touches these members, and the exit ORDER relative to a
 * restart is the whole point: a real child cannot be told to exit at a chosen
 * moment, so the one case that matters could not be written against it.
 */
class FakeOpenCodeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  killed = false

  constructor(readonly pid: number, readonly port: string) {
    super()
  }

  /** Print the line the adapter waits for before it calls the server ready. */
  announceListening() {
    this.stdout.emit("data", Buffer.from(`opencode server listening on http://127.0.0.1:${this.port}\n`))
  }

  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM")
    this.killed = true
    return true
  }
}

function fakeSpawner() {
  const children: FakeOpenCodeChild[] = []
  const waiting: Array<(child: FakeOpenCodeChild) => void> = []
  const spawn = ((_command: string, args: readonly string[]) => {
    const port = String(args.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? "0")
    const child = new FakeOpenCodeChild(9000 + children.length, port)
    children.push(child)
    for (const resolve of waiting.splice(0)) resolve(child)
    return child
  }) as unknown as typeof spawnReal

  return {
    spawn,
    children,
    /** Resolves with the next child spawned after this call. */
    next: () => new Promise<FakeOpenCodeChild>((resolve) => { waiting.push(resolve) }),
  }
}

const scratchEnv = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const
const restoreEnv: Array<() => void> = []
const scratchDirs: string[] = []

/** Keep `prepareSpawnEnv`'s mkdirs inside a temp dir instead of the real data dir. */
function scratchSpawnDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-spawn-"))
  scratchDirs.push(dir)
  for (const name of scratchEnv) {
    const previous = process.env[name]
    restoreEnv.push(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
    process.env[name] = path.join(dir, name.toLowerCase())
  }
}

afterEach(async () => {
  for (const restore of restoreEnv.splice(0)) restore()
  await Promise.all(scratchDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("opencode server process", () => {
  test("external-URL mode neither spawns nor invents a credential", async () => {
    // An operator-supplied server is not ours to authenticate. Its credential,
    // if any, arrives through the caller's own headers.
    const server = new OpenCodeServerProcess("http://opencode.test:4096", inputs)

    expect(server.mode).toBe("external")
    expect(server.hasProcess).toBe(false)
    expect(await server.ensureConnection()).toEqual({ url: "http://opencode.test:4096" })
    expect(await server.ensureServer()).toBe("http://opencode.test:4096")
  })

  test("external-URL mode hands out a no-op lease", async () => {
    // Callers lease unconditionally; there is no child to keep alive here, and
    // making them branch on mode would put the lifecycle decision at every
    // call site.
    const server = new OpenCodeServerProcess("http://opencode.test:4096", inputs)
    const { connection, lease } = await server.acquire()

    expect(connection.authorization).toBeUndefined()
    expect(() => {
      lease.release()
      lease.release()
    }).not.toThrow()
  })

  test("restart reports nothing to restart before a child exists", () => {
    expect(new OpenCodeServerProcess(undefined, inputs).restartSpawnedProcess()).toBe(false)
    expect(new OpenCodeServerProcess("http://opencode.test:4096", inputs).restartSpawnedProcess()).toBe(false)
  })

  test("spawn mode reports itself as spawned and holds no process until asked", () => {
    // Loading the adapter selects no harness and starts nothing.
    const server = new OpenCodeServerProcess(undefined, inputs)

    expect(server.mode).toBe("spawned")
    expect(server.hasProcess).toBe(false)
  })

  test("a replaced child's late exit does not take down its replacement", async () => {
    // A restart kills the old child and starts a new one immediately, so the
    // old child's `exit` arrives when the replacement is already serving. The
    // exit handler stops the lifecycle, and unscoped that stop reaps the
    // healthy replacement — the adapter then reports no process at all and the
    // next request pays a second cold start.
    scratchSpawnDirs()
    const spawner = fakeSpawner()
    const server = new OpenCodeServerProcess(undefined, { ...inputs, spawn: spawner.spawn })

    const connecting = server.ensureConnection()
    const first = await spawner.next()
    first.announceListening()
    await connecting
    expect(server.hasProcess).toBe(true)

    expect(server.restartSpawnedProcess()).toBe(true)
    const reconnecting = server.ensureConnection()
    const second = await spawner.next()
    second.announceListening()
    await reconnecting
    expect(server.hasProcess).toBe(true)
    expect(first.signals).toEqual(["SIGTERM"])

    // The replaced child now reports the exit its own SIGTERM caused.
    first.emit("exit", 0, "SIGTERM")

    expect(server.hasProcess).toBe(true)
    expect(second.signals).toEqual([])
    expect(spawner.children).toHaveLength(2)

    server.dispose()
  })

  test("redaction removes every occurrence of the launch credential", () => {
    // Server stdout and startup failures are logged verbatim, and the engine
    // echoes configuration back. One occurrence missed is the credential in a
    // log file.
    const credential = "s3cret-launch-credential"
    const text = `starting with ${credential}\nretrying with ${credential}`

    const redacted = redact(text, credential)

    expect(redacted).not.toContain(credential)
    expect(redacted.split("«redacted»")).toHaveLength(3)
  })

  test("redaction is a no-op when there is no credential to hide", () => {
    expect(redact("plain output", undefined)).toBe("plain output")
  })
})
