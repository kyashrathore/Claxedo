import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectProxy, deriveHostname, dryRunCheck, makeRouteConflictInfo, sanitize, tryRegister } from "./portless"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"))
})

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  delete process.env.WORKSPACE_RUNTIME_DISABLE_PORTLESS
})

describe("sanitize", () => {
  test("lowercases", () => {
    expect(sanitize("Web")).toBe("web")
  })

  test("replaces underscores and dots with hyphens", () => {
    expect(sanitize("my_api.foo")).toBe("my-api-foo")
  })

  test("collapses runs of hyphens", () => {
    expect(sanitize("a__b...c")).toBe("a-b-c")
  })

  test("trims leading/trailing hyphens", () => {
    expect(sanitize("--foo--")).toBe("foo")
  })

  test("returns empty string for unsanitizable input", () => {
    expect(sanitize("___")).toBe("")
  })
})

describe("deriveHostname", () => {
  test("composes port name + workspace + tld by default", () => {
    expect(deriveHostname({
      portName: "web",
      workspaceName: "myapp",
      workspaceId: "ws_123",
      tld: "localhost",
    })).toBe("web.myapp.localhost")
  })

  test("appends a hash-based workspaceId discriminator on pick-new", () => {
    // Discriminator is sha256("abcdef1234567890").digest("hex").slice(0, 10),
    // not a substring of the workspaceId itself — see the "discriminator
    // collisions (regression)" describe block below for why that matters.
    expect(deriveHostname({
      portName: "web",
      workspaceName: "main",
      workspaceId: "abcdef1234567890",
      tld: "localhost",
      withDiscriminator: true,
    })).toBe("web.main-840881e18c.localhost")
  })

  test("returns null when port name sanitizes to empty", () => {
    expect(deriveHostname({
      portName: "___",
      workspaceName: "myapp",
      workspaceId: "ws_123",
      tld: "localhost",
    })).toBeNull()
  })

  test("returns null when workspaceName missing and not using discriminator", () => {
    expect(deriveHostname({
      portName: "web",
      workspaceName: undefined,
      workspaceId: "ws_123",
      tld: "localhost",
    })).toBeNull()
  })

  test("falls back to discriminator-only label when workspaceName missing on pick-new", () => {
    expect(deriveHostname({
      portName: "web",
      workspaceName: undefined,
      workspaceId: "abcdef1234567890",
      tld: "localhost",
      withDiscriminator: true,
    })).toBe("web.840881e18c.localhost")
  })

  test("returns null on pick-new when workspaceId missing", () => {
    expect(deriveHostname({
      portName: "web",
      workspaceName: "myapp",
      workspaceId: undefined,
      tld: "localhost",
      withDiscriminator: true,
    })).toBeNull()
  })

  test("honors custom tld", () => {
    expect(deriveHostname({
      portName: "api",
      workspaceName: "myapp",
      workspaceId: "ws_123",
      tld: "test",
    })).toBe("api.myapp.test")
  })

  test("sanitizes both labels", () => {
    expect(deriveHostname({
      portName: "API_v2",
      workspaceName: "My App",
      workspaceId: "ws_123",
      tld: "localhost",
    })).toBe("api-v2.my-app.localhost")
  })
})

// Regression coverage for the hostname-collision bug: the discriminator used
// to be `sanitize(workspaceId).slice(0, 6)`. For the real
// `ws_<base36 millis>_<random>` id shape, six sanitized characters barely
// clears the `ws-` prefix and lands inside the (slow-changing) timestamp, so
// every workspace minted within the same ~46-hour window produced the same
// discriminator — precisely when it needed to disambiguate. These tests
// exercise the fixed hash-based scheme against that exact failure mode.
describe("deriveHostname discriminator collisions (regression)", () => {
  // Mirrors control-plane/workspace-id.ts's real shape: `ws_` + 8 base36
  // timestamp chars + `_` + 16 random chars. idA/idB share everything but the
  // last character of the random suffix — the old scheme could not tell
  // these apart because six sanitized chars never reaches that far.
  const idA = "ws_m1n2o3p4_nm0p1q2r3s4t5u6v"
  const idB = "ws_m1n2o3p4_nm0p1q2r3s4t5u6w"

  test("two ids sharing a timestamp prefix, differing only in the random suffix, produce different discriminators", () => {
    // Sanity check that this pair really does defeat the old scheme (first 6
    // sanitized chars identical) — confirms this test targets the real bug.
    expect(sanitize(idA).slice(0, 6)).toBe(sanitize(idB).slice(0, 6))

    const hostnameA = deriveHostname({
      portName: "web",
      workspaceName: "main",
      workspaceId: idA,
      tld: "localhost",
      withDiscriminator: true,
    })
    const hostnameB = deriveHostname({
      portName: "web",
      workspaceName: "main",
      workspaceId: idB,
      tld: "localhost",
      withDiscriminator: true,
    })
    expect(hostnameA).not.toBeNull()
    expect(hostnameB).not.toBeNull()
    expect(hostnameA).not.toBe(hostnameB)
  })

  test("a batch of 100 realistic ids minted in the same window all produce distinct hostnames", () => {
    // Same `ws_<millis>_` prefix for every id (same millisecond window is the
    // whole point of the bug); sequential suffixes stand in for the random
    // part real ids carry, varying only near the end of the string exactly
    // like real random suffixes do.
    const hostnames = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const workspaceId = `ws_m1n2o3p4_${String(i).padStart(16, "0")}`
      const hostname = deriveHostname({
        portName: "web",
        workspaceName: "main",
        workspaceId,
        tld: "localhost",
        withDiscriminator: true,
      })
      expect(hostname).not.toBeNull()
      hostnames.add(hostname as string)
    }
    expect(hostnames.size).toBe(100)
  })

  test("the same workspace id yields an identical hostname across repeated calls", () => {
    const input = {
      portName: "web",
      workspaceName: "main",
      workspaceId: idA,
      tld: "localhost",
      withDiscriminator: true,
    }
    const first = deriveHostname(input)
    const second = deriveHostname(input)
    const third = deriveHostname({ ...input })
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test("stays within DNS label limits and uses only legal characters with a long workspaceName (discriminator path)", () => {
    const longName = "a".repeat(200)
    const hostname = deriveHostname({
      portName: "web",
      workspaceName: longName,
      workspaceId: idA,
      tld: "localhost",
      withDiscriminator: true,
    })
    expect(hostname).not.toBeNull()
    const wsLabel = (hostname as string).split(".")[1]!
    expect(wsLabel.length).toBeLessThanOrEqual(63)
    expect(wsLabel).toMatch(/^[a-z0-9-]+$/)
    expect(wsLabel.startsWith("-")).toBe(false)
    expect(wsLabel.endsWith("-")).toBe(false)
    // The 10-hex-char discriminator must survive truncation in full — it's
    // the part actually doing disambiguation, so it's never what gets cut.
    expect(wsLabel).toMatch(/-[0-9a-f]{10}$/)
  })

  test("stays within DNS label limits and uses only legal characters with a long workspaceName (no discriminator)", () => {
    const longName = "b".repeat(200)
    const hostname = deriveHostname({
      portName: "web",
      workspaceName: longName,
      workspaceId: undefined,
      tld: "localhost",
    })
    expect(hostname).not.toBeNull()
    const wsLabel = (hostname as string).split(".")[1]!
    expect(wsLabel.length).toBeLessThanOrEqual(63)
    expect(wsLabel).toMatch(/^[a-z0-9-]+$/)
  })
})

describe("detectProxy", () => {
  test("returns null when state dir is missing", () => {
    expect(detectProxy(path.join(tmpDir, "missing"))).toBeNull()
  })

  test("returns null when proxy.port is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    expect(detectProxy(tmpDir)).toBeNull()
  })

  test("returns null when proxy.pid is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    expect(detectProxy(tmpDir)).toBeNull()
  })

  test("returns null when recorded PID is not alive", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), "1") // pid 1 lives, but use a clearly-dead one
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), "99999999")
    expect(detectProxy(tmpDir)).toBeNull()
  })

  test("returns proxy state when files present and PID alive", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    const result = detectProxy(tmpDir)
    expect(result).toEqual({
      stateDir: tmpDir,
      proxyPort: 1355,
      proxyPid: process.pid,
      tls: false,
      tld: "localhost",
    })
  })

  test("picks up tls marker", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "443")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    fs.writeFileSync(path.join(tmpDir, "tls"), "")
    const result = detectProxy(tmpDir)
    expect(result?.tls).toBe(true)
  })

  test("picks up custom tld", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    fs.writeFileSync(path.join(tmpDir, "tld"), "test")
    const result = detectProxy(tmpDir)
    expect(result?.tld).toBe("test")
  })

  test("returns null when WORKSPACE_RUNTIME_DISABLE_PORTLESS=1", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    process.env.WORKSPACE_RUNTIME_DISABLE_PORTLESS = "1"
    expect(detectProxy(tmpDir)).toBeNull()
  })

  test("returns null when proxy.port is not a positive integer", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "garbage")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    expect(detectProxy(tmpDir)).toBeNull()
  })
})

describe("dryRunCheck", () => {
  test("returns null when no route exists for hostname", () => {
    const store = { loadRoutes: () => [] }
    expect(dryRunCheck(store, "web.myapp.localhost")).toBeNull()
  })

  test("returns hit when route exists", () => {
    const store = { loadRoutes: () => [{ hostname: "web.myapp.localhost", pid: 12345 }] }
    expect(dryRunCheck(store, "web.myapp.localhost")).toEqual({
      hostname: "web.myapp.localhost",
      pid: 12345,
    })
  })

  test("ignores routes for other hostnames", () => {
    const store = { loadRoutes: () => [{ hostname: "api.other.localhost", pid: 12345 }] }
    expect(dryRunCheck(store, "web.myapp.localhost")).toBeNull()
  })

  test("returns null when loadRoutes throws", () => {
    const store = { loadRoutes: (): Array<{ hostname: string; pid: number }> => { throw new Error("disk full") } }
    expect(dryRunCheck(store, "web.myapp.localhost")).toBeNull()
  })
})

describe("tryRegister", () => {
  test("returns ok on success (RouteStore.addRoute returns void)", () => {
    const store = { addRoute: (_h: string, _p: number, _pid: number, _f?: boolean) => undefined }
    const result = tryRegister(store, "web.myapp.localhost", 5173, 12345, false)
    expect(result).toEqual({ ok: true })
  })

  test("ignores any value addRoute happens to return", () => {
    // Real Portless returns void; if a future version returned something, we still
    // signal success without leaking that value to callers.
    const store = { addRoute: (_h: string, _p: number, _pid: number, _f?: boolean) => 9999 as unknown as void }
    const result = tryRegister(store, "web.myapp.localhost", 5173, 12345, true)
    expect(result).toEqual({ ok: true })
  })

  test("converts RouteConflictError to conflict result", async () => {
    const { RouteConflictError } = await import("portless")
    const store = {
      addRoute: () => {
        throw new RouteConflictError("web.myapp.localhost", 7777)
      },
    }
    const result = tryRegister(store, "web.myapp.localhost", 5173, 12345, false)
    expect(result).toEqual({
      ok: false,
      kind: "conflict",
      hostname: "web.myapp.localhost",
      pid: 7777,
    })
  })

  test("converts other thrown errors to error result", () => {
    const store = {
      addRoute: () => {
        throw new Error("disk full")
      },
    }
    const result = tryRegister(store, "web.myapp.localhost", 5173, 12345, false)
    expect(result).toMatchObject({
      ok: false,
      kind: "error",
      message: "disk full",
    })
  })
})

describe("makeRouteConflictInfo", () => {
  test("builds RouteConflictInfo with required fields", () => {
    const info = makeRouteConflictInfo("web.myapp.localhost", 12345)
    expect(info).toEqual({
      type: "route-conflict",
      hostname: "web.myapp.localhost",
      pid: 12345,
    })
  })
})
