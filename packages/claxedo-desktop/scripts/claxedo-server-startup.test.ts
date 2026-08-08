import { describe, expect, test } from "bun:test"
import { claxedoServerStartup, watchDesktopParent } from "./claxedo-server-startup"

describe("Claxedo server utility startup", () => {
  test("defaults to SDK-next embedded OpenCode when no external URL is configured", () => {
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      opencodeUrl: undefined,
      opencodePassword: null,
    })
  })

  test("preserves the explicit external OpenCode opt-in", () => {
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_URL: "http://127.0.0.1:4096",
      CLAXEDO_CHILD_OPENCODE_PASSWORD: "secret",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      opencodeUrl: "http://127.0.0.1:4096",
      opencodePassword: "secret",
    })
  })

  test("passes through the embedded engine artifact path", () => {
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: "/opt/claxedo/opencode-engine/node.js",
      CLAXEDO_CHILD_OPENCODE_WORKER_PATH: "/opt/claxedo/claxedo-engine-worker/index.js",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      opencodeUrl: undefined,
      opencodePassword: null,
      opencodeEmbedPath: "/opt/claxedo/opencode-engine/node.js",
      opencodeWorkerPath: "/opt/claxedo/claxedo-engine-worker/index.js",
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
