import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CLAXEDO_DAEMON_PROTOCOL,
  clearClaxedoDaemonDiscovery,
  readClaxedoDaemonDiscovery,
  stopUnhealthyPublishedDaemon,
  verifyClaxedoDaemonDiscovery,
  writeClaxedoDaemonDiscovery,
  type ClaxedoDaemonDiscovery,
} from "./server-daemon-discovery"

/** The URL of a `fetch` double's argument, whichever of the three forms it takes. */
function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(overrides: Partial<ClaxedoDaemonDiscovery> = {}): ClaxedoDaemonDiscovery {
  return {
    service: "claxedo-local-daemon",
    protocol: CLAXEDO_DAEMON_PROTOCOL,
    generation: "generation-1",
    token: "secret-token",
    pid: 42,
    port: 2593,
    startedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  }
}

describe("Claxedo daemon discovery", () => {
  test("publishes an owner-only record and reads it back", () => {
    const root = mkdtempSync(join(tmpdir(), "claxedo-daemon-discovery-"))
    roots.push(root)
    const path = join(root, "daemon.json")
    const record = fixture()

    writeClaxedoDaemonDiscovery(path, record)

    expect(readClaxedoDaemonDiscovery(path)).toEqual(record)
    // Windows does not expose its ACL through POSIX mode bits; Bun reports
    // 0o666 even after chmodSync(0o600). Keep the owner-only mode oracle on
    // platforms whose filesystem API can represent the contract.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record)
  })

  test("authenticates the process at the recorded endpoint before adoption", async () => {
    const record = fixture()
    const requests: Array<{ url: string; authorization: string | null }> = []

    const verified = await verifyClaxedoDaemonDiscovery(record, async (input, init) => {
      requests.push({
        url: requestUrl(input),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return Response.json({
        service: record.service,
        protocol: record.protocol,
        generation: record.generation,
        pid: record.pid,
      })
    })

    expect(verified).toBe("http://127.0.0.1:2593")
    expect(requests).toEqual([{
      url: "http://127.0.0.1:2593/api/claxedo/daemon",
      authorization: "Bearer secret-token",
    }])
  })

  test("rejects a process whose authenticated identity does not match the record", async () => {
    const record = fixture()
    const verified = await verifyClaxedoDaemonDiscovery(record, async () =>
      Response.json({ ...record, pid: record.pid + 1 }))

    expect(verified).toBeUndefined()
  })

  test("stops a live published pid that failed health, escalating if SIGTERM is ignored", async () => {
    const signals: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = []
    let alive = true

    const result = await stopUnhealthyPublishedDaemon(fixture({ pid: 99454 }), {
      alive: () => alive,
      stop: async (pid, signal) => {
        signals.push({ pid, signal })
        if (signal === "SIGKILL") alive = false
      },
      wait: async () => undefined,
    })

    expect(result).toBe("stopped")
    expect(signals).toEqual([
      { pid: 99454, signal: "SIGTERM" },
      { pid: 99454, signal: "SIGKILL" },
    ])
  })

  test("does not stop a published pid that is already gone", async () => {
    const stopped: number[] = []
    const result = await stopUnhealthyPublishedDaemon(fixture(), {
      alive: () => false,
      stop: async (pid) => {
        stopped.push(pid)
      },
      wait: async () => undefined,
    })

    expect(result).toBe("absent")
    expect(stopped).toEqual([])
  })

  test("only the owning generation can clear a replacement record", () => {
    const root = mkdtempSync(join(tmpdir(), "claxedo-daemon-discovery-"))
    roots.push(root)
    const path = join(root, "daemon.json")
    const first = fixture()
    const replacement = fixture({ generation: "generation-2", token: "replacement-token", pid: 84 })
    writeClaxedoDaemonDiscovery(path, replacement)

    clearClaxedoDaemonDiscovery(path, first)
    expect(readClaxedoDaemonDiscovery(path)).toEqual(replacement)

    clearClaxedoDaemonDiscovery(path, replacement)
    expect(readClaxedoDaemonDiscovery(path)).toBeUndefined()
  })
})
