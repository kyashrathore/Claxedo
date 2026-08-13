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
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      opencodeUrl: undefined,
      opencodePassword: null,
      opencodeEmbedPath: "/opt/claxedo/opencode-engine/node.js",
    })
  })

  test("passes through BOTH shipped compile cache directories and the profile they are seeded into", () => {
    // All three are consumed by `claxedo-server-boot.ts` before the product
    // entry is COMPILED. They are asserted together because the seeding needs
    // all of them: the engine's shipped entries, the server bundle's own, and
    // the writable profile whose runtime-computed cache directory both are
    // copied into.
    expect(claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: "/opt/claxedo/opencode-engine/node.js",
      CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: "/opt/claxedo/opencode-compile-cache",
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
      CLAXEDO_DATA_DIR: "/Users/test/Library/Application Support/Claxedo",
    })).toEqual({
      port: 3210,
      desktopParentPid: 99,
      opencodeUrl: undefined,
      opencodePassword: null,
      opencodeEmbedPath: "/opt/claxedo/opencode-engine/node.js",
      opencodeCompileCacheDir: "/opt/claxedo/opencode-compile-cache",
      serverCompileCacheDir: "/opt/claxedo/claxedo-server-compile-cache",
      dataDir: "/Users/test/Library/Application Support/Claxedo",
    })
  })

  test("a build that shipped no compile cache is not a configuration error", () => {
    const startup = claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: "/opt/claxedo/opencode-engine/node.js",
    })
    expect(startup.opencodeCompileCacheDir).toBeUndefined()
    expect(startup.serverCompileCacheDir).toBeUndefined()
    expect(startup.dataDir).toBeUndefined()
  })

  test("either shipped set may be absent without the other being dropped", () => {
    // A build that generated one cache and not the other must still hand over
    // the one it has. The seeding path filters per SET, and this is the input
    // side of that.
    const engineOnly = claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: "/opt/claxedo/opencode-compile-cache",
    })
    expect(engineOnly.opencodeCompileCacheDir).toBe("/opt/claxedo/opencode-compile-cache")
    expect(engineOnly.serverCompileCacheDir).toBeUndefined()

    const serverOnly = claxedoServerStartup({
      CLAXEDO_CHILD_PORT: "3210",
      CLAXEDO_DESKTOP_PARENT_PID: "99",
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
    })
    expect(serverOnly.opencodeCompileCacheDir).toBeUndefined()
    expect(serverOnly.serverCompileCacheDir).toBe("/opt/claxedo/claxedo-server-compile-cache")
  })

  test("never surfaces an engine WORKER path — the desktop runs the engine in-process", () => {
    // Deliberate absence, recorded so it cannot drift back silently.
    //
    // The worker transport was wired and measured (six runs vs a v5 control):
    // cold ready 1,875 -> 2,004 ms, peak family RSS ~1,930 -> 2,060 MiB, and
    // quiescent CPU failed its 5% budget in two of six runs. The engine did
    // move out of the server child (374.6 -> ~190 MiB) but the worker costs
    // 310 MiB, so one process became two for +125 MiB net — and the idle-exit
    // meant to repay it never fired (alive in all 18 process snapshots).
    // `peak_process_family_rss_mib` is a PEAK, so an exit AFTER the peak
    // cannot reduce it even in principle.
    //
    // Asserting on the whole object is the point: an option reintroduced here
    // fails this test rather than being silently accepted downstream, which is
    // how it was lost the first time (a conditional spread at the call site
    // evades TypeScript's excess-property check).
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
