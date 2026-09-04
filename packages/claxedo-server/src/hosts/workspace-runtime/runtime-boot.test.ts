import { describe, expect, test } from "vitest"
import { exportSPKI, generateKeyPair } from "jose"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import {
  claxedoCorsOrigin,
  claxedoRuntimeRunnerFromEnv,
  claxedoWorkspaceRuntimeBootFromEnv,
  claxedoWorkspaceRuntimeLaunch,
} from "./runtime-boot"

describe("claxedo workspace-runtime boot policy", () => {
  test("launches the package bin with workspace-and-epoch scoped short-lived credentials", () => {
    expect(claxedoWorkspaceRuntimeLaunch({
      workspaceId: "ws_1",
      hostId: "host_1",
      sandboxId: "sandbox_1",
      leaseId: "lease_1",
      epoch: 7,
      directory: "/workspace",
      port: 2593,
      credential: { token: "bootstrap-token", expiresAt: 20_000 },
      now: 10_000,
    })).toEqual({
      command: ["workspace-runtime"],
      env: expect.objectContaining({
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
        WORKSPACE_RUNTIME_HOST_ID: "sandbox_1",
        WORKSPACE_RUNTIME_LEASE_ID: "lease_1",
        WORKSPACE_RUNTIME_EPOCH: "7",
        WORKSPACE_RUNTIME_DIRECTORY: "/workspace",
        WORKSPACE_RUNTIME_PORT: "2593",
        WORKSPACE_RUNTIME_CONFIG_TOKEN: "bootstrap-token",
        WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "bootstrap-token",
        WORKSPACE_RUNTIME_BOOTSTRAP_EXPIRES_AT: "20000",
      }),
    })
    expect(() => claxedoWorkspaceRuntimeLaunch({
      workspaceId: "ws_1",
      hostId: "host_1",
      sandboxId: "sandbox_1",
      leaseId: "lease_1",
      epoch: 7,
      directory: "/workspace",
      port: 2593,
      credential: { token: "expired", expiresAt: 10_000 },
      now: 10_000,
    })).toThrow("expired")
  })

  test.each([
    ["epoch NaN", { epoch: Number.NaN }],
    ["epoch infinity", { epoch: Number.POSITIVE_INFINITY }],
    ["port NaN", { port: Number.NaN }],
    ["port zero", { port: 0 }],
    ["expiry infinity", { credential: { token: "token", expiresAt: Number.POSITIVE_INFINITY } }],
    ["now NaN", { now: Number.NaN }],
  ])("rejects invalid launch input: %s", (_name, override) => {
    expect(() => claxedoWorkspaceRuntimeLaunch({
      workspaceId: "ws_1",
      hostId: "host_1",
      sandboxId: "sandbox_1",
      leaseId: "lease_1",
      epoch: 1,
      directory: "/workspace",
      port: 2593,
      credential: { token: "bootstrap-token", expiresAt: 20_000 },
      now: 10_000,
      ...override,
    })).toThrow()
  })
  test("defaults: port 3002, loopback exposure, opencode native runner", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
    })
    expect(boot.port).toBe(3002)
    expect(boot.hostname).toBe("127.0.0.1")
    expect(boot.options.exposure?.kind).toBe("loopback")
    expect(boot.options.harness).toEqual({ id: "opencode", access: "native" })
    expect(boot.options.target).toEqual({ workspaceId: "ws-env", directory: process.cwd() })
    expect(boot.options.relayHostAuth).toBeUndefined()
    expect(boot.options.hostTunnel).toBeUndefined()
    // Claxedo keeps OpenCode compat ON by default (kit default is off).
    expect(boot.options.opencodeCompat).toBe(true)
  })

  test("forwards the host entry's route contributions into the server options", async () => {
    const contribution = { id: "agent-plugins", mount: () => ({ path: "/", routes: {} as never, dispose() {} }) }
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_test", WORKSPACE_RUNTIME_WORKSPACE_DIR: "/workspace" }, {
      routeContributions: [contribution as never],
    })
    expect(boot.options.routeContributions).toEqual([contribution])
    const plain = await claxedoWorkspaceRuntimeBootFromEnv({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_test", WORKSPACE_RUNTIME_WORKSPACE_DIR: "/workspace" })
    expect(plain.options.routeContributions).toBeUndefined()
  })

  test("compat env flag decodes to opencodeCompat=false", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_OPENCODE_COMPAT: "0",
    })
    expect(boot.options.opencodeCompat).toBe(false)
  })

  test("runner parsing: acp alias, named harness, acp binary connection", () => {
    expect(claxedoRuntimeRunnerFromEnv({ WORKSPACE_RUNTIME_RUNNER: "acp" })).toEqual({ id: "claude", access: "acp" })
    expect(claxedoRuntimeRunnerFromEnv({ WORKSPACE_RUNTIME_RUNNER: "codex" })).toMatchObject({ id: "codex" })
    expect(claxedoRuntimeRunnerFromEnv({
      WORKSPACE_RUNTIME_RUNNER: "acp",
      WORKSPACE_RUNTIME_ACP_BINARY: "/usr/local/bin/claude-agent-acp",
    })).toEqual({
      id: "claude",
      access: "acp",
      connection: { kind: "process", binary: "/usr/local/bin/claude-agent-acp" },
    })
  })

  test("rejects an unknown explicit runner", () => {
    expect(() => claxedoRuntimeRunnerFromEnv({ WORKSPACE_RUNTIME_RUNNER: "mystery" })).toThrow(
      "Unknown WORKSPACE_RUNTIME_RUNNER",
    )
  })

  test.each(["abc", "3002junk", "0", "65536", "1.5"])("rejects invalid runtime port %s", async (port) => {
    await expect(claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_PORT: port,
    })).rejects.toThrow("WORKSPACE_RUNTIME_PORT")
  })

  test("non-loopback host without relay auth composes the dev-unsafe exposure", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_HOST: "0.0.0.0",
    })
    expect(boot.hostname).toBe("0.0.0.0")
    expect(boot.options.exposure?.kind).toBe("private-network")
  })

  test("relay env wires relay exposure and the host tunnel", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
      WORKSPACE_RUNTIME_RELAY_URL: "https://relay.example",
    })
    expect(boot.options.exposure?.kind).toBe("relay")
    expect(boot.options.relayHostAuth).toBeDefined()
    expect(boot.options.hostTunnel).toMatchObject({ relayUrl: "https://relay.example", hostId: "ws-env" })
  })

  test("boot composes claxedo's cors policy", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
    })
    expect(boot.options.corsOrigin).toBe(claxedoCorsOrigin)
  })
})

describe("claxedo cors policy", () => {
  const loopback = loopbackWorkspaceRuntimeExposure()

  test("allows claxedo.com and localhost on loopback exposure", () => {
    expect(claxedoCorsOrigin("https://app.claxedo.com", loopback)).toBe("https://app.claxedo.com")
    expect(claxedoCorsOrigin("https://claxedo.com", loopback)).toBe("https://claxedo.com")
    expect(claxedoCorsOrigin("http://localhost:4444", loopback)).toBe("http://localhost:4444")
    expect(claxedoCorsOrigin("http://127.0.0.1:3000", loopback)).toBe("http://127.0.0.1:3000")
  })

  // Upstream's hosted app is no longer a default first-party origin.
  test("rejects opencode.ai on loopback exposure", () => {
    expect(claxedoCorsOrigin("https://app.opencode.ai", loopback)).toBeUndefined()
    expect(claxedoCorsOrigin("https://opencode.ai", loopback)).toBeUndefined()
  })

  test("rejects other origins and non-loopback exposures", () => {
    expect(claxedoCorsOrigin("https://evil.example", loopback)).toBeUndefined()
    expect(claxedoCorsOrigin("https://claxedo.com.evil.example", loopback)).toBeUndefined()
    const relay = relayWorkspaceRuntimeExposure({
      key: new Uint8Array([1]),
      workspaceId: "ws_1",
      hostId: "host_1",
    })
    expect(claxedoCorsOrigin("https://app.claxedo.com", relay)).toBeUndefined()
    expect(claxedoCorsOrigin("http://localhost:4444", relay)).toBeUndefined()
  })
})
