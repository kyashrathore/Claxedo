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
  delete process.env.CLAXEDO_DISABLE_PORTLESS
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

  test("appends 6-char workspaceId discriminator on pick-new", () => {
    expect(deriveHostname({
      portName: "web",
      workspaceName: "main",
      workspaceId: "abcdef1234567890",
      tld: "localhost",
      withDiscriminator: true,
    })).toBe("web.main-abcdef.localhost")
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
    })).toBe("web.abcdef.localhost")
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

  test("returns null when CLAXEDO_DISABLE_PORTLESS=1", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355")
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), String(process.pid))
    process.env.CLAXEDO_DISABLE_PORTLESS = "1"
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
