import { describe, expect, test } from "bun:test"
import { claxedoServerStartup } from "./claxedo-server-startup"

const DAEMON_ENV = {
  CLAXEDO_CHILD_PORT: "3210",
  CLAXEDO_DAEMON_PROTOCOL: "1",
  CLAXEDO_DAEMON_TOKEN: "installation-secret",
  CLAXEDO_DAEMON_GENERATION: "generation-1",
  CLAXEDO_DAEMON_DISCOVERY_PATH: "/tmp/claxedo/local-daemon.json",
}

const expectedDaemon = {
  port: 3210,
  daemonProtocol: 1,
  daemonToken: "installation-secret",
  daemonGeneration: "generation-1",
  daemonDiscoveryPath: "/tmp/claxedo/local-daemon.json",
}

describe("Claxedo server daemon startup", () => {
  test("requires a complete daemon identity and no desktop parent", () => {
    expect(claxedoServerStartup(DAEMON_ENV)).toEqual({
      ...expectedDaemon,
      opencodeUrl: undefined,
      opencodePassword: null,
      opencodeEmbedPath: undefined,
      opencodeCompileCacheDir: undefined,
      serverCompileCacheDir: undefined,
      dataDir: undefined,
    })
    expect(() => claxedoServerStartup({ CLAXEDO_CHILD_PORT: "3210" })).toThrow("missing its daemon identity")
  })

  test("preserves the explicit external OpenCode opt-in", () => {
    expect(claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_OPENCODE_URL: "http://127.0.0.1:4096",
      CLAXEDO_CHILD_OPENCODE_PASSWORD: "secret",
    })).toMatchObject({
      ...expectedDaemon,
      opencodeUrl: "http://127.0.0.1:4096",
      opencodePassword: "secret",
    })
  })

  test("passes through the engine artifact, compile caches, and data root", () => {
    expect(claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: "/opt/claxedo/opencode-engine/node.js",
      CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: "/opt/claxedo/opencode-compile-cache",
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
      CLAXEDO_DATA_DIR: "/Users/test/Library/Application Support/Claxedo",
    })).toEqual({
      ...expectedDaemon,
      opencodeUrl: undefined,
      opencodePassword: null,
      opencodeEmbedPath: "/opt/claxedo/opencode-engine/node.js",
      opencodeCompileCacheDir: "/opt/claxedo/opencode-compile-cache",
      serverCompileCacheDir: "/opt/claxedo/claxedo-server-compile-cache",
      dataDir: "/Users/test/Library/Application Support/Claxedo",
    })
  })

  test("either compile-cache set may be absent", () => {
    const engineOnly = claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: "/opt/claxedo/opencode-compile-cache",
    })
    expect(engineOnly.opencodeCompileCacheDir).toBe("/opt/claxedo/opencode-compile-cache")
    expect(engineOnly.serverCompileCacheDir).toBeUndefined()

    const serverOnly = claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
    })
    expect(serverOnly.opencodeCompileCacheDir).toBeUndefined()
    expect(serverOnly.serverCompileCacheDir).toBe("/opt/claxedo/claxedo-server-compile-cache")
  })

  test("never surfaces an engine worker path", () => {
    expect(claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_OPENCODE_WORKER_PATH: "/opt/claxedo/claxedo-engine-worker/index.js",
    })).not.toHaveProperty("opencodeWorkerPath")
  })

  test("rejects a missing process port", () => {
    expect(() => claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_PORT: undefined,
    })).toThrow("missing its startup configuration")
  })
})
