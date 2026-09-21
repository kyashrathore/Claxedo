import { describe, expect, test } from "bun:test"
import { claxedoServerStartup } from "./claxedo-server-startup"
import { CLAXEDO_DAEMON_PROTOCOL } from "../src/main/server-daemon-discovery"

const DAEMON_ENV = {
  CLAXEDO_CHILD_PORT: "3210",
  CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
  CLAXEDO_DAEMON_TOKEN: "installation-secret",
  CLAXEDO_DAEMON_GENERATION: "generation-1",
  CLAXEDO_DAEMON_DISCOVERY_PATH: "/tmp/claxedo/local-daemon.json",
}

const expectedDaemon = {
  port: 3210,
  daemonProtocol: CLAXEDO_DAEMON_PROTOCOL,
  daemonToken: "installation-secret",
  daemonGeneration: "generation-1",
  daemonDiscoveryPath: "/tmp/claxedo/local-daemon.json",
}

describe("Claxedo server daemon startup", () => {
  test("requires a complete daemon identity and no desktop parent", () => {
    expect(claxedoServerStartup(DAEMON_ENV)).toEqual({
      ...expectedDaemon,
      serverCompileCacheDir: undefined,
      dataDir: undefined,
    })
    expect(() => claxedoServerStartup({ CLAXEDO_CHILD_PORT: "3210" })).toThrow("missing its daemon identity")
  })

  test("passes through the server compile cache and data root", () => {
    expect(claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
      CLAXEDO_DATA_DIR: "/Users/test/Library/Application Support/Claxedo",
    })).toEqual({
      ...expectedDaemon,
      serverCompileCacheDir: "/opt/claxedo/claxedo-server-compile-cache",
      dataDir: "/Users/test/Library/Application Support/Claxedo",
    })
  })

  test("the server compile cache may be absent", () => {
    const serverOnly = claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: "/opt/claxedo/claxedo-server-compile-cache",
    })
    expect(serverOnly.serverCompileCacheDir).toBe("/opt/claxedo/claxedo-server-compile-cache")
    expect(claxedoServerStartup(DAEMON_ENV).serverCompileCacheDir).toBeUndefined()
  })

  test("rejects a missing process port", () => {
    expect(() => claxedoServerStartup({
      ...DAEMON_ENV,
      CLAXEDO_CHILD_PORT: undefined,
    })).toThrow("missing its startup configuration")
  })
})
