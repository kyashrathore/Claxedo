import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { withClaxedoMessageAuthor } from "../../../agent-event-runtime/src/projections/opencode-compat"
import type { EventMessageUpdated } from "../../../agent-event-runtime/src/projections/opencode-compat"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-two-user-signed-"))
const previous = Object.fromEntries([
  "HOME",
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_STATE_DIR",
  "CLAXEDO_SIGNED_CLOUD_AUTH",
  "CLAXEDO_EMBEDDED_AUTH",
  "CLAXEDO_WORKSPACE_AUTHORITY_URL",
].map((key) => [key, process.env[key]]))

process.env.HOME = path.join(root, "home")
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
process.env.CLAXEDO_EMBEDDED_AUTH = "1"
delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL

await Promise.all([
  fs.mkdir(process.env.HOME, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_DATA_DIR, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_STATE_DIR, { recursive: true }),
])

const [
  { createSelfHostedApp },
  { createControlPlaneServices },
  { createSqliteCentralStore },
  { createSqliteWorkspaceAuthority },
  { openAuthorityDb },
  { controlPlaneAuthContext, betterAuthAdapter },
  { getEmbeddedAuth, EMBEDDED_AUTH_ISSUER },
  { ClaxedoDB },
] = await Promise.all([
  import("../deployments/self-hosted-node/app"),
  import("./services"),
  import("./adapters/sqlite/central-store"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"),
  import("@claxedo/server-core/platform/auth/auth"),
  import("../deployments/self-hosted-node/embedded-auth"),
  import("../platform/db"),
])

const embedded = getEmbeddedAuth()
const authorityPath = path.join(root, "authority.sqlite")
const authority = createSqliteWorkspaceAuthority({ path: authorityPath })
const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
const services = createControlPlaneServices({
  projectionStore: centralStore.projectionStore,
  durableSessionLog: centralStore.durableSessionLog,
}, {
  authority,
  auth: betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: embedded.verifier }),
})
const app = createSelfHostedApp(services).app
const inspectAuthority = openAuthorityDb({ path: authorityPath })

type SignedAuth = Exclude<Awaited<ReturnType<typeof controlPlaneAuthContext>>, { mode: "unsigned-local" }>

afterAll(async () => {
  inspectAuthority().close()
  embedded.close()
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe("two-user signed app transport", () => {
  test("uses real bearer sessions for private-session HTTP policy and participant revocation", async () => {
    const alice = await signUp("alice@two-user.test", "Alice")
    const bob = await signUp("bob@two-user.test", "Bob")
    const casey = await signUp("casey@two-user.test", "Casey")
    const [aliceAuth, bobAuth, caseyAuth] = await Promise.all([
      verifiedAuth(alice.token),
      verifiedAuth(bob.token),
      verifiedAuth(casey.token),
    ])
    const [aliceIdentity, bobIdentity, caseyIdentity] = await Promise.all([
      authority.usersMe(aliceAuth),
      authority.usersMe(bobAuth),
      authority.usersMe(caseyAuth),
    ]) as Array<{
      actor_id: string
      actor_public_id: string
      token_identifier: string
    }>

    inspectAuthority().prepare("UPDATE users SET name = ?, image_url = ? WHERE token_identifier = ?")
      .run("Alice", "https://images.example.test/alice.png", aliceIdentity.token_identifier)
    inspectAuthority().prepare("UPDATE users SET name = ?, image_url = ? WHERE token_identifier = ?")
      .run("Bob", "https://images.example.test/bob.png", bobIdentity.token_identifier)

    await authority.createCloudWorkspace(aliceAuth, {
      workspaceId: "ws_signed_private",
      displayName: "Signed private workspace",
      repoUrl: "https://github.com/acme/private.git",
    })
    for (const identity of [bobIdentity, caseyIdentity]) {
      const response = await signedRequest(alice.token, "/api/workspace/ws_signed_private/shares", {
        method: "POST",
        body: JSON.stringify({ role: "editor", grantedToTokenIdentifier: identity.token_identifier }),
      })
      expect(response.status).toBe(200)
    }
    await authority.upsertSessionVisibility(aliceAuth, {
      workspaceId: "ws_signed_private",
      sessions: [{ sessionId: "ses_signed_private", title: "Signed private session" }],
    })
    await authority.syncSessionMessages(aliceAuth, {
      workspaceId: "ws_signed_private",
      sessionId: "ses_signed_private",
      messages: [{ id: "msg_alice", role: "user", text: "Alice wrote this" }],
    })

    for (const user of [bob, casey]) {
      const list = await signedRequest(user.token, "/api/control/sessions?workspaceId=ws_signed_private")
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toEqual({ sessions: [] })

      const messages = await signedRequest(
        user.token,
        "/api/control/sessions/ses_signed_private/messages?workspaceId=ws_signed_private",
      )
      expect(messages.status).toBe(200)
      await expect(messages.json()).resolves.toMatchObject({ allowed: false, messages: [] })
    }

    const added = await signedRequest(alice.token, "/api/control/sessions/ses_signed_private/participants", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "ws_signed_private",
        participantTokenIdentifier: bobIdentity.token_identifier,
      }),
    })
    expect(added.status).toBe(200)
    await expect(added.json()).resolves.toMatchObject({ participant_id: expect.any(String) })

    const bobMessages = await signedRequest(
      bob.token,
      "/api/control/sessions/ses_signed_private/messages?workspaceId=ws_signed_private",
    )
    expect(bobMessages.status).toBe(200)
    await expect(bobMessages.json()).resolves.toMatchObject({
      allowed: true,
      messages: [{ id: "msg_alice", role: "user" }],
    })
    await expect(authority.syncSessionMessages(bobAuth, {
      workspaceId: "ws_signed_private",
      sessionId: "ses_signed_private",
      messages: [
        { id: "msg_alice", role: "user", text: "Alice wrote this" },
        { id: "msg_bob", role: "user", text: "Bob replied" },
      ],
    })).resolves.toEqual({ ok: true })
    await expect(authority.syncSessionMessages(caseyAuth, {
      workspaceId: "ws_signed_private",
      sessionId: "ses_signed_private",
      messages: [{ id: "msg_casey", role: "user", text: "Casey must not write" }],
    })).rejects.toMatchObject({ status: 403, code: "workspace_authorization_denied" })

    const [aliceProfile, bobProfile] = await Promise.all([
      authority.usersMe(aliceAuth),
      authority.usersMe(bobAuth),
    ]) as Array<{
      actor_id: string
      actor_public_id: string
      actor_name: string
      actor_avatar_url: string
    }>
    const projected = [aliceProfile, bobProfile].map((profile, index) =>
      withClaxedoMessageAuthor({
        id: `msg_${index}`,
        sessionID: "ses_signed_private",
        role: "user",
        time: { created: index + 1 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
      } as EventMessageUpdated["properties"]["info"], {
        id: profile.actor_public_id,
        name: profile.actor_name,
        avatarUrl: profile.actor_avatar_url,
        kind: "human",
      })
    )
    expect(projected.map((message) => message.claxedo?.author)).toEqual([
      {
        id: aliceProfile.actor_public_id,
        name: "Alice",
        avatarUrl: "https://images.example.test/alice.png",
        kind: "human",
      },
      {
        id: bobProfile.actor_public_id,
        name: "Bob",
        avatarUrl: "https://images.example.test/bob.png",
        kind: "human",
      },
    ])
    expect(JSON.stringify(projected)).not.toContain(aliceProfile.actor_id)
    expect(JSON.stringify(projected)).not.toContain(bobProfile.actor_id)

    await authority.recordRuntimeAccessToken(bobAuth, {
      jti: "jti_signed_bob",
      workspaceId: "ws_signed_private",
      hostId: "host_signed",
      actorId: bobProfile.actor_id,
      actorKind: "human",
      role: "editor",
      expiresAt: Date.now() + 60_000,
    })
    const removed = await signedRequest(alice.token, "/api/control/sessions/ses_signed_private/participants", {
      method: "DELETE",
      body: JSON.stringify({
        workspaceId: "ws_signed_private",
        participantTokenIdentifier: bobIdentity.token_identifier,
      }),
    })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toEqual({ removed: true })
    const revoked = await signedRequest(alice.token, "/api/workspace/ws_signed_private/shares", {
      method: "DELETE",
      body: JSON.stringify({ grantedToTokenIdentifier: bobIdentity.token_identifier }),
    })
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_signed_bob",
      workspaceId: "ws_signed_private",
      hostId: "host_signed",
    })).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    const afterRemoval = await signedRequest(
      bob.token,
      "/api/control/sessions/ses_signed_private/messages?workspaceId=ws_signed_private",
    )
    await expect(afterRemoval.json()).resolves.toMatchObject({ allowed: false, messages: [] })
  })
})

async function signUp(email: string, name: string) {
  const response = await app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  })
  expect(response.status).toBe(200)
  const token = response.headers.get("set-auth-token")
  expect(token).toBeTruthy()
  return { token: token! }
}

async function verifiedAuth(token: string) {
  const auth = await controlPlaneAuthContext(
    new Request("https://control.example.test", { headers: { authorization: `Bearer ${token}` } }),
    services.auth,
  )
  if (auth.mode !== "signed") throw new Error("Expected signed auth")
  return auth as SignedAuth
}

function signedRequest(token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  headers.set("content-type", "application/json")
  headers.set("origin", "https://app.claxedo.test")
  headers.set("x-opencode-directory", "/workspace")
  return app.request(`https://control.example.test${pathname}`, { ...init, headers })
}
