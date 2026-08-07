import { describe, expect, test } from "bun:test"
import { OpenCodeServerProcess, redact } from "./process"

const inputs = { config: () => ({}), auth: () => ({}) }

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
    // U8-F3: loading the adapter selects no harness and starts nothing.
    const server = new OpenCodeServerProcess(undefined, inputs)

    expect(server.mode).toBe("spawned")
    expect(server.hasProcess).toBe(false)
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
