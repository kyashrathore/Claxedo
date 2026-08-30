import { describe, expect, test } from "bun:test"
import { claxedoServerStartup, watchDesktopParent } from "./claxedo-server-startup"

describe("Claxedo server utility startup", () => {
  test("returns the embedded server configuration owned by the desktop", () => {
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
      CLAXEDO_DATA_DIR: "/Users/test/Library/Application Support/Claxedo",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      serverCompileCacheDir: "/opt/claxedo/claxedo-server-compile-cache",
      dataDir: "/Users/test/Library/Application Support/Claxedo",
    })
  })

  test("ignores every retired external, artifact, and worker OpenCode setting", () => {
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_URL: "http://127.0.0.1:4096",
      CLAXEDO_CHILD_OPENCODE_PASSWORD: "secret",
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: "/opt/claxedo/opencode-engine/node.js",
      CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: "/opt/claxedo/opencode-compile-cache",
      CLAXEDO_CHILD_OPENCODE_WORKER_PATH: "/opt/claxedo/claxedo-engine-worker/index.js",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      serverCompileCacheDir: undefined,
      dataDir: undefined,
    })
  })

  test("rejects a missing utility-process port", () => {
    expect(() => claxedoServerStartup({})).toThrow("missing its startup configuration")
  })

  test("rejects a missing desktop owner", () => {
    expect(() => claxedoServerStartup({ CLAXEDO_CHILD_PORT: "3210" })).toThrow("missing its desktop owner")
  })

  test("terminates when the desktop owner no longer exists", async () => {
    let probes = 0
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("owner watchdog did not fire")), 1_000)
      const stop = watchDesktopParent({
        pid: 99,
        intervalMs: 1,
        probe() {
          probes += 1
          throw Object.assign(new Error("missing"), { code: "ESRCH" })
        },
        onOrphaned() {
          clearTimeout(timeout)
          stop()
          resolve()
        },
      })
    })
    expect(probes).toBe(1)
  })
})
