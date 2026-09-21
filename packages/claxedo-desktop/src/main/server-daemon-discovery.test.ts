import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CLAXEDO_DAEMON_PROTOCOL,
  clearClaxedoDaemonDiscovery,
  readClaxedoDaemonDiscovery,
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

function identity() {
  return {
    pid: 42,
    processGroupId: 42,
    parentPid: 1,
    startSecond: "Thu Jan  1 00:00:00 1970",
    bootTime: "0",
    source: "darwin-ps" as const,
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

  test("a listener that disagrees about its own process identity is not the recorded daemon", async () => {
    const record = fixture({ identity: identity() })
    const verified = await verifyClaxedoDaemonDiscovery(record, async () =>
      Response.json({ ...record, identity: { ...identity(), startSecond: "Fri Jan  2 00:00:00 1970" } }))

    expect(verified).toBeUndefined()
  })

  test("a record carrying an identity the listener repeats is adopted", async () => {
    const record = fixture({ identity: identity() })
    const verified = await verifyClaxedoDaemonDiscovery(record, async () => Response.json(record))

    expect(verified).toBe(`http://127.0.0.1:${record.port}`)
  })

  test("an identity that is not one is dropped rather than read back as a record", () => {
    const root = mkdtempSync(join(tmpdir(), "claxedo-daemon-discovery-"))
    roots.push(root)
    const path = join(root, "daemon.json")
    writeFileSync(path, JSON.stringify({ ...fixture(), identity: { pid: 42 } }))

    expect(readClaxedoDaemonDiscovery(path)).toBeUndefined()
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
