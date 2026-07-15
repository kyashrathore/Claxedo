import { describe, expect, test } from "vitest"
import { exportSPKI, generateKeyPair } from "jose"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { claxedoCorsOrigin, claxedoRuntimeRunnerFromEnv, claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

describe("claxedo workspace-runtime boot policy", () => {
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

  test("compat env flag decodes to opencodeCompat=false", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_DISABLE_OPENCODE_COMPAT: "1",
    })
    expect(boot.options.opencodeCompat).toBe(false)
  })

  test("wires the trusted WorkGraph broker origin from host composition", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: "https://central.example",
    })
    expect(boot.options.workgraphConnectionBrokerOrigin).toBe("https://central.example")
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

  test("allows opencode.ai and localhost on loopback exposure", () => {
    expect(claxedoCorsOrigin("https://app.opencode.ai", loopback)).toBe("https://app.opencode.ai")
    expect(claxedoCorsOrigin("https://opencode.ai", loopback)).toBe("https://opencode.ai")
    expect(claxedoCorsOrigin("http://localhost:4444", loopback)).toBe("http://localhost:4444")
    expect(claxedoCorsOrigin("http://127.0.0.1:3000", loopback)).toBe("http://127.0.0.1:3000")
  })

  test("rejects other origins and non-loopback exposures", () => {
    expect(claxedoCorsOrigin("https://evil.example", loopback)).toBeUndefined()
    expect(claxedoCorsOrigin("https://opencode.ai.evil.example", loopback)).toBeUndefined()
    const relay = relayWorkspaceRuntimeExposure({
      key: new Uint8Array([1]),
      workspaceId: "ws_1",
      hostId: "host_1",
    })
    expect(claxedoCorsOrigin("https://app.opencode.ai", relay)).toBeUndefined()
    expect(claxedoCorsOrigin("http://localhost:4444", relay)).toBeUndefined()
  })
})
