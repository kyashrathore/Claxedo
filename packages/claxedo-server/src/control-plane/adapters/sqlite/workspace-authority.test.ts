import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import { describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "../../auth"
import { createSqliteWorkspaceAuthority, localControlPlaneAuth } from "./workspace-authority"

function signedAuth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `tok_${subject}`,
    user: {
      subject,
      tokenIdentifier: `https://idp.example.test|${subject}`,
      issuer: "https://idp.example.test",
    },
  }
}

const owner = signedAuth("user_owner")
const other = signedAuth("user_other")

function memoryAuthority() {
  return createSqliteWorkspaceAuthority({ path: ":memory:" })
}

function hostKeyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
    privateKey: pair.privateKey,
  }
}

// Client-side host attestation signing (mirror of routes/workspace-local-host.ts).
function signPayload(privateKey: KeyObject, payload: string) {
  return signData("sha256", Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
}

function registrationPayload(input: { workspaceId: string; hostId: string; challengeId: string; nonce: string }) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: { workspaceId: string; hostId: string; ttlMs?: number }) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

describe("sqlite workspace authority", () => {
  test("creator owns the workspace; others are denied until a share grant flips it", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_1", displayName: "One" })

    const listed = await authority.listWorkspaces(owner) as Array<{ workspace_id: string; role: string; access: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ workspace_id: "ws_1", role: "owner", access: "cloud" })

    const opened = await authority.openWorkspace(owner, { workspaceId: "ws_1" })
    expect(opened.allowed).toBe(true)
    expect(opened.role).toBe("owner")
    expect(opened.workspace).toMatchObject({ workspace_id: "ws_1", backing: "cloud-vm", access: "cloud" })

    await expect(authority.openWorkspace(other, { workspaceId: "ws_1" })).rejects.toMatchObject({
      status: 403,
      code: "workspace_authorization_denied",
    })
    expect(await authority.listWorkspaces(other)).toEqual([])

    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "editor",
      grantedToClerkSubject: "user_other",
    })
    const shared = await authority.openWorkspace(other, { workspaceId: "ws_1" })
    expect(shared.role).toBe("editor")
    expect((await authority.listWorkspaces(other) as unknown[])).toHaveLength(1)

    const revoked = await authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_1",
      grantedToClerkSubject: "user_other",
    })
    expect(revoked).toMatchObject({ revoked: true })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_1" })).rejects.toMatchObject({ status: 403 })
  })

  test("usersMe/resolveOrgId mint a stable personal org", async () => {
    const authority = memoryAuthority()
    const me = await authority.usersMe(owner) as { org_id: string; token_identifier: string }
    expect(me.token_identifier).toBe(owner.user.tokenIdentifier)
    expect(me.org_id).toMatch(/^org_/)
    expect(await authority.resolveOrgId(owner)).toBe(me.org_id)
    expect(await authority.resolveOrgId(owner)).toBe(me.org_id)
    expect(await authority.resolveOrgId(other)).not.toBe(me.org_id)
  })

  test("local host link challenge/register/heartbeat/pause flow with real attestation", async () => {
    const authority = memoryAuthority()
    const key = hostKeyPair()
    const hostId = "host_test_1"

    const challenge = await authority.createLocalHostLinkChallenge(owner, { workspaceId: "ws_local", hostId })
    expect(challenge.challenge_id).toBeTruthy()
    expect(challenge.expires_at).toBeGreaterThan(Date.now())

    const link = await authority.registerLocalHostLink(owner, {
      workspaceId: "ws_local",
      hostId,
      publicKey: key.publicKey,
      challengeId: challenge.challenge_id,
      signature: signPayload(key.privateKey, registrationPayload({
        workspaceId: "ws_local",
        hostId,
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
      displayName: "Local One",
    }) as { host_id: string; paused: boolean }
    expect(link).toMatchObject({ host_id: hostId, paused: false })

    // Registration created the workspace, owned by the proving caller.
    const opened = await authority.openWorkspace(owner, { workspaceId: "ws_local" })
    expect(opened.workspace).toMatchObject({ backing: "local-worktree", access: "user-hosted" })

    // A used challenge cannot register again.
    await expect(authority.registerLocalHostLink(owner, {
      workspaceId: "ws_local",
      hostId,
      publicKey: key.publicKey,
      challengeId: challenge.challenge_id,
      signature: "resigned",
    })).rejects.toThrow("Invalid host attestation challenge")

    const active = await authority.activeLocalHostLink(owner, { workspaceId: "ws_local" })
    expect(active).toMatchObject({ active: true, host_id: hostId, workspace_id: "ws_local" })

    const beat = await authority.heartbeatLocalHostLink(owner, {
      workspaceId: "ws_local",
      hostId,
      signature: signPayload(key.privateKey, heartbeatPayload({ workspaceId: "ws_local", hostId, ttlMs: 120_000 })),
      ttlMs: 120_000,
    }) as { expires_at: number; paused: boolean }
    expect(beat.paused).toBe(false)
    expect(beat.expires_at).toBeGreaterThan(Date.now())

    // A bad heartbeat signature is rejected against the registered key.
    await expect(authority.heartbeatLocalHostLink(owner, {
      workspaceId: "ws_local",
      hostId,
      signature: signPayload(key.privateKey, "tampered"),
    })).rejects.toThrow("Invalid host attestation")

    await authority.pauseLocalHostLink(owner, { workspaceId: "ws_local", hostId, paused: true })
    expect(await authority.activeLocalHostLink(owner, { workspaceId: "ws_local" })).toEqual({ active: false })

    await authority.pauseLocalHostLink(owner, { workspaceId: "ws_local", hostId, paused: false })
    expect(await authority.activeLocalHostLink(owner, { workspaceId: "ws_local" })).toMatchObject({ active: true })
  })

  test("runtime access tokens: record, active checks, revoke", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_rt", displayName: "RT" })
    const expiresAt = Date.now() + 60_000

    await authority.recordRuntimeAccessToken(owner, {
      jti: "jti_1",
      workspaceId: "ws_rt",
      hostId: "host_a",
      expiresAt,
    })
    await expect(authority.recordRuntimeAccessToken(owner, {
      jti: "jti_1",
      workspaceId: "ws_rt",
      hostId: "host_a",
      expiresAt,
    })).rejects.toThrow("Runtime Access Token already recorded")

    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_a" }))
      .toEqual({ active: true })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_b" }))
      .toMatchObject({ active: false, code: "runtime_access_token_mismatch" })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_missing", workspaceId: "ws_rt", hostId: "host_a" }))
      .toMatchObject({ active: false, code: "runtime_access_token_unknown" })

    await authority.revokeRuntimeAccessToken(owner, { jti: "jti_1", workspaceId: "ws_rt" })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_a" }))
      .toMatchObject({ active: false, code: "runtime_access_token_revoked" })
  })

  test("agent extensions: admin-gated writes, runtime list without auth, source conflict", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ext", displayName: "Ext" })

    await authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@acme/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "acme", repo: "tool" } },
      lock: { version: "1.0.0" },
    })
    const forRuntime = await authority.listWorkspaceAgentExtensionsForRuntime({ workspaceId: "ws_ext" }) as Array<{
      enabled: boolean
      desired: { id: string }
    }>
    expect(forRuntime).toHaveLength(1)
    expect(forRuntime[0]).toMatchObject({ enabled: true })
    expect(forRuntime[0]!.desired).toMatchObject({ id: "ext_1" })

    await expect(authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@acme/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "evil", repo: "tool" } },
      lock: {},
    })).rejects.toThrow("Agent Extension is already installed from a different source")

    await expect(authority.upsertWorkspaceAgentExtension(other, {
      workspaceId: "ws_ext",
      extensionId: "ext_2",
      packageName: "@acme/other",
      desired: { id: "ext_2", enabled: true },
      lock: {},
    })).rejects.toThrow("Workspace not found")

    await authority.setWorkspaceAgentExtensionEnabled(owner, { workspaceId: "ws_ext", extensionId: "ext_1", enabled: false })
    const disabled = await authority.listWorkspaceAgentExtensions(owner, { workspaceId: "ws_ext" }) as Array<{ enabled: boolean }>
    expect(disabled[0]).toMatchObject({ enabled: false })

    await authority.setAgentExtensionPolicyOverride(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      scope: "workspace",
      enabled: false,
      reason: "blocked",
    })
    expect(await authority.listAgentExtensionPolicyOverridesForRuntime({ workspaceId: "ws_ext" })).toEqual([
      { id: "ext_1", scope: "workspace", enabled: false, reason: "blocked" },
    ])

    // A soft-deleted row no longer guards its source: uninstalling and then
    // installing the same id from a different source revives the row instead
    // of rejecting (absorbed legacy records leave the same tombstones).
    await authority.deleteWorkspaceAgentExtension(owner, { workspaceId: "ws_ext", extensionId: "ext_1" })
    await authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@other/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "other", repo: "tool" } },
      lock: {},
    })
    const revived = await authority.listWorkspaceAgentExtensions(owner, { workspaceId: "ws_ext" }) as Array<{
      desired: { source: { owner: string } }
    }>
    expect(revived).toHaveLength(1)
    expect(revived[0]!.desired.source).toMatchObject({ owner: "other" })
  })

  test("session visibility + message sync stay workspace-scoped", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_s", displayName: "S" })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_s",
      sessions: [{ sessionId: "ses_1", title: "First" }],
    })
    await authority.authorizeSessionRead(owner, { sessionId: "ses_1", workspaceId: "ws_s" })
    await expect(authority.authorizeSessionRead(other, { sessionId: "ses_1", workspaceId: "ws_s" }))
      .rejects.toMatchObject({ status: 403 })

    await authority.syncSessionMessages(owner, {
      sessionId: "ses_1",
      workspaceId: "ws_s",
      messages: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
    })
    const read = await authority.readSessionMessages(owner, { sessionId: "ses_1", workspaceId: "ws_s" }) as {
      allowed: boolean
      messages: unknown[]
    }
    expect(read.allowed).toBe(true)
    expect(read.messages).toEqual([{ info: { id: "msg_1", role: "user" }, parts: [] }])

    await authority.replaceSessionVisibility(owner, { workspaceId: "ws_s", sessions: [] })
    expect(await authority.listSessions(owner, { workspaceId: "ws_s" })).toEqual([])
  })

  test("channel authorization denies without an identity mapping", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ch", displayName: "Ch" })
    expect(await authority.authorizeChannelProject({
      channel: "telegram",
      externalUserId: "tg_1",
      threadKey: "t_1",
      projectId: "prj_ws_ch",
      action: "read",
    })).toEqual({ ok: false })
    await expect(authority.authorizeChannelWorkspace({
      channel: "telegram",
      externalUserId: "tg_1",
      threadKey: "t_1",
      workspaceId: "ws_ch",
      action: "read",
    })).rejects.toMatchObject({ status: 403 })
  })

  test("the synthetic local identity is the degenerate single-user case", async () => {
    const authority = memoryAuthority()
    const local = localControlPlaneAuth()
    expect(local.user).toMatchObject({ subject: "local", tokenIdentifier: "local:default" })
    await authority.registerLocalForSharing(local, { workspaceId: "ws_home", displayName: "Home" })
    const listed = await authority.listWorkspaces(local) as Array<{ workspace_id: string; role: string }>
    expect(listed).toEqual([expect.objectContaining({ workspace_id: "ws_home", role: "owner" })])
  })
})

describe("default local composition", () => {
  test("no Convex/Clerk env still composes a workspace authority (no 503)", async () => {
    const previous = {
      dataDir: process.env.CLAXEDO_DATA_DIR,
      signed: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      authorityUrl: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-"))
    process.env.CLAXEDO_DATA_DIR = dir
    delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const { createDefaultLocalControlPlaneServices } = await import("../../../server")
      const services = createDefaultLocalControlPlaneServices()
      // The whole point of the SQLite authority: `requireAuthority` must never
      // throw its 503 in an unconfigured self-host deployment.
      expect(services.authority).toBeDefined()
      await expect(services.authority!.listWorkspaces(localControlPlaneAuth())).resolves.toEqual([])
    } finally {
      for (const [key, value] of [
        ["CLAXEDO_DATA_DIR", previous.dataDir],
        ["CLAXEDO_SIGNED_CLOUD_AUTH", previous.signed],
        ["CLAXEDO_WORKSPACE_AUTHORITY_URL", previous.authorityUrl],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
