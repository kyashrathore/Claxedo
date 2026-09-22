import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { mintOwnerGrant } from "../../session/owner-grant"
import { FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID } from "./first-party-mcp"
import {
  claxedoCorsOrigin,
  claxedoRuntimeHarnessFromEnv,
  claxedoWorkspaceRuntimeBootFromEnv,
  claxedoWorkspaceRuntimeLaunch,
} from "./runtime-boot"

describe("claxedo workspace-runtime boot policy", () => {
  test("installs the clone placeholder as a GitHub-only authorization header before boot returns", async () => {
    // Outside the repository: a checkout on CI carries its own
    // http.https://github.com/.extraheader in the local config, which git
    // reads ahead of the global file the boot writes.
    const directory = await mkdtemp(path.join(os.tmpdir(), "broker-git-test-"))
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-git",
      WORKSPACE_RUNTIME_DIRECTORY: directory,
      CLAXEDO_GITHUB_CLONE_AUTH: "dtn_secret_clone",
    }
    const git = (args: string[]) => execFileSync("git", args, { env, cwd: directory, encoding: "utf8" }).trim()
    try {
      await claxedoWorkspaceRuntimeBootFromEnv(env)
      expect(git(["config", "--get-urlmatch", "http.extraheader", "https://github.com/acme/private.git"]))
        .toBe("Authorization: dtn_secret_clone")
      expect(() => git(["config", "--get-urlmatch", "http.extraheader", "https://github.com.evil.test/acme/private.git"]))
        .toThrow()
      expect(() => git(["config", "--get-urlmatch", "http.extraheader", "http://github.com/acme/private.git"]))
        .toThrow()
      await claxedoWorkspaceRuntimeBootFromEnv({ ...env, CLAXEDO_GITHUB_CLONE_AUTH: "dtn_secret_rotated" })
      expect(git(["config", "--get-all", "http.https://github.com/.extraheader"]))
        .toBe("Authorization: dtn_secret_rotated")
      await expect(claxedoWorkspaceRuntimeBootFromEnv({
        ...env, CLAXEDO_GITHUB_CLONE_AUTH: "dtn_secret_clone\r\nX-Injected: value",
      })).rejects.toThrow("Invalid GitHub clone authorization header")
      await expect(claxedoWorkspaceRuntimeBootFromEnv({
        ...env, GIT_CONFIG_GLOBAL: path.join(directory, "missing", "config"),
      })).rejects.toThrow()
      // Withdrawal: the header an earlier boot wrote outlives the restart, so a
      // wake without the placeholder has to remove it rather than keep using a
      // credential the control plane took away.
      const { CLAXEDO_GITHUB_CLONE_AUTH: _withdrawn, ...withoutClone } = env
      await claxedoWorkspaceRuntimeBootFromEnv(withoutClone)
      expect(() => git(["config", "--get-all", "http.https://github.com/.extraheader"])).toThrow()
      // Nothing to remove is the ordinary case, not a boot failure.
      await expect(claxedoWorkspaceRuntimeBootFromEnv(withoutClone)).resolves.toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  test("launches the package bin with workspace-and-epoch scoped short-lived credentials", () => {
    const launch = claxedoWorkspaceRuntimeLaunch({
      workspaceId: "ws_1",
      hostId: "host_1",
      leaseId: "lease_1",
      epoch: 7,
      directory: "/workspace",
      port: 2593,
      credential: { token: "bootstrap-token", expiresAt: 20_000 },
      now: 10_000,
    })
    expect(launch).toEqual({
      command: ["workspace-runtime"],
      env: expect.objectContaining({
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
        // The launch's stated host identity survives the lease env composed
        // over it; the relay binds this host on exactly this value.
        WORKSPACE_RUNTIME_HOST_ID: "host_1",
        WORKSPACE_RUNTIME_LEASE_ID: "lease_1",
        WORKSPACE_RUNTIME_EPOCH: "7",
        WORKSPACE_RUNTIME_DIRECTORY: "/workspace",
        WORKSPACE_RUNTIME_PORT: "2593",
        WORKSPACE_RUNTIME_CONFIG_TOKEN: "bootstrap-token",
      }),
    })
    expect(launch.env).not.toHaveProperty("WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN")
    expect(launch.env).not.toHaveProperty("WORKSPACE_RUNTIME_BOOTSTRAP_EXPIRES_AT")
    expect(() => claxedoWorkspaceRuntimeLaunch({
      workspaceId: "ws_1",
      hostId: "host_1",
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
      leaseId: "lease_1",
      epoch: 1,
      directory: "/workspace",
      port: 2593,
      credential: { token: "bootstrap-token", expiresAt: 20_000 },
      now: 10_000,
      ...override,
    })).toThrow()
  })
  test("defaults: port 3002, loopback exposure, no implicit harness", async () => {
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
    })
    expect(boot.port).toBe(3002)
    expect(boot.hostname).toBe("127.0.0.1")
    expect(boot.options.exposure?.kind).toBe("loopback")
    expect(boot.options.harness).toBeUndefined()
    expect(boot.options.connectionProviders?.map((provider) => provider.providerKey)).toEqual([
      "acp",
      "opencode-server",
    ])
    expect(boot.options.target).toEqual({ workspaceId: "ws-env", directory: process.cwd() })
    expect(boot.options.relayHostAuth).toBeUndefined()
    expect(boot.options.hostTunnel).toBeUndefined()
  })

  test("forwards the host entry's route contributions and always mounts the first-party MCP beside them", async () => {
    const contribution = { id: "agent-plugins", mount: () => ({ path: "/", routes: {} as never, dispose() {} }) }
    const env = { WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_test", WORKSPACE_RUNTIME_DIRECTORY: process.cwd() }
    const boot = await claxedoWorkspaceRuntimeBootFromEnv(env, { routeContributions: [contribution as never] })
    expect(boot.options.routeContributions?.map((entry) => entry.id))
      .toEqual(["agent-plugins", FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID])
    const plain = await claxedoWorkspaceRuntimeBootFromEnv(env)
    expect(plain.options.routeContributions?.map((entry) => entry.id))
      .toEqual([FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID])
  })

  test("owns a public embedded-SDK runtime only when the native OpenCode harness is selected", async () => {
    const env = { WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_test", WORKSPACE_RUNTIME_DIRECTORY: process.cwd() }
    const plain = await claxedoWorkspaceRuntimeBootFromEnv(env)
    expect(plain.options.opencodeRuntime).toBeUndefined()
    expect(plain.options.ownsOpenCodeRuntime).toBeUndefined()
    const pi = await claxedoWorkspaceRuntimeBootFromEnv({ ...env, WORKSPACE_RUNTIME_NATIVE_HARNESS: "pi" })
    expect(pi.options.opencodeRuntime).toBeUndefined()
    const opencode = await claxedoWorkspaceRuntimeBootFromEnv({ ...env, WORKSPACE_RUNTIME_NATIVE_HARNESS: "opencode" })
    expect(opencode.options.opencodeRuntime).toBeDefined()
    expect(opencode.options.ownsOpenCodeRuntime).toBe(true)
    await opencode.options.opencodeRuntime!.close()
  })

  test("selects either an explicit native harness or a configured connection", () => {
    expect(claxedoRuntimeHarnessFromEnv({})).toBeUndefined()
    expect(claxedoRuntimeHarnessFromEnv({ WORKSPACE_RUNTIME_NATIVE_HARNESS: "codex" })).toEqual({ kind: "native", harnessId: "codex" })
    expect(claxedoRuntimeHarnessFromEnv({ WORKSPACE_RUNTIME_CONNECTION_ID: "openclaw" })).toEqual({ kind: "connection", connectionId: "openclaw" })
    expect(() => claxedoRuntimeHarnessFromEnv({ WORKSPACE_RUNTIME_CONNECTION_ID: "openclaw", WORKSPACE_RUNTIME_NATIVE_HARNESS: "pi" })).toThrow("Choose either")
  })

  test("rejects an unknown explicit runner", () => {
    expect(() => claxedoRuntimeHarnessFromEnv({ WORKSPACE_RUNTIME_NATIVE_HARNESS: "mystery" })).toThrow(
      "Unsupported WORKSPACE_RUNTIME_NATIVE_HARNESS",
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

  test("seeds the first-party issuer with the owner the grant names, and verifies that grant with the management key", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const signing = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
    const scope = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws-env" }
    const grant = await mintOwnerGrant(scope, signing)
    const boot = await claxedoWorkspaceRuntimeBootFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env",
      WORKSPACE_RUNTIME_DIRECTORY: process.cwd(),
      WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: await exportSPKI(key.publicKey),
      WORKSPACE_RUNTIME_OWNER_GRANT: grant.token,
    })
    const issuer = boot.options.firstPartyMcpLaunch!.issuer
    expect(issuer.verify(issuer.current("ses_1"))).toMatchObject({ userId: "alice", sessionId: "ses_1", workspaceId: "ws-env" })
    const identity = boot.options.ownerGrantIdentity
    expect(identity).toBeDefined()
    expect(await identity!(grant.token)).toMatchObject({ actor_id: "actor:alice", org_id: "org-1", workspace_id: "ws-env", role: "owner" })
    expect(await identity!((await mintOwnerGrant({ ...scope, workspaceId: "ws-other" }, signing)).token)).toBeUndefined()
    const foreign = await generateKeyPair("EdDSA", { extractable: true })
    const forged = await mintOwnerGrant(scope, {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(foreign.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(foreign.publicKey),
    })
    expect(await identity!(forged.token)).toBeUndefined()

    const plain = await claxedoWorkspaceRuntimeBootFromEnv({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-env", WORKSPACE_RUNTIME_DIRECTORY: process.cwd() })
    const plainIssuer = plain.options.firstPartyMcpLaunch!.issuer
    expect(plainIssuer.verify(plainIssuer.current("ses_1"))?.userId).toBeUndefined()
    expect(plain.options.ownerGrantIdentity).toBeUndefined()
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
