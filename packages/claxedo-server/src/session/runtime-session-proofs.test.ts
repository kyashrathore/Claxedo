import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"
import { relayProofVerifier } from "./runtime-session-proofs"

const owner = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_machine-1",
  role: "owner" as const,
  jti: "rat_owner_1",
}

const transitionStubs = {
  registerRuntimeSession: async () => ({}),
  authorizeRuntimeSessionStartStatus: async () => {},
  authorizeRuntimeSessionStart: async () => {},
  markSessionRegistrationAmbiguous: async () => ({}) as never,
  beginSessionCompensation: async () => ({}) as never,
  completeSessionCompensation: async () => ({}) as never,
}

async function oracle() {
  const controlPlane = await generateKeyPair("EdDSA", { extractable: true })
  const relay = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(controlPlane.publicKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(controlPlane.privateKey),
    CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relay.publicKey),
  }
  const runtimeAccessTokenActive = vi.fn(async (_input: { jti: string; workspaceId: string; hostId: string }) => ({ active: true }) as Record<string, unknown>)
  const authorizeRuntimeSession = vi.fn(async (_input: Record<string, unknown>) => {})
  const authority = { ...transitionStubs, authorizeRuntimeSession, runtimeAccessTokenActive }
  const target = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
    authority,
    verifyRelayProof: relayProofVerifier(env, authority),
    env,
  }))
  const ask = (token: string, body: Record<string, unknown>) => target.request("/api/runtime-authority/session-authorize", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const mint = (overrides: Partial<Parameters<typeof mintRuntimeAccessToken>[0]> = {}, signer = controlPlane.privateKey) =>
    mintRuntimeAccessToken({ ...owner, ...overrides }, signer, "EdDSA")
  return { env, relay, mint, ask, runtimeAccessTokenActive, authorizeRuntimeSession }
}

describe("the owner's Runtime Access Token as a machine's proof", () => {
  test("names the same principal a relay host token minted from it would, with its own jti as the parent", async () => {
    const h = await oracle()
    const rows = { runtimeAccessTokenActive: h.runtimeAccessTokenActive }
    const fromToken = await relayProofVerifier(h.env, rows)(await h.mint())
    const fromRelay = await relayProofVerifier(h.env, rows)(await mintRelayHostToken({ ...owner, jti: "rht_1", parentJti: "rat_owner_1", backing: "local-worktree" }, h.relay.privateKey, "EdDSA"))

    expect(fromToken).toEqual({ ...fromRelay, jti: "rat_owner_1" })
    expect(fromToken.parent_jti).toBe("rat_owner_1")
  })

  test("is no proof to an oracle that cannot recheck its row", async () => {
    const h = await oracle()

    await expect(relayProofVerifier(h.env)(await h.mint())).rejects.toThrow("cannot recheck")
  })

  test("host_read and a session read are decided for its actor, and its own row is read for each", async () => {
    const h = await oracle()
    const token = await h.mint()

    const host = await h.ask(token, { action: "host_read" })
    expect(host.status).toBe(200)
    expect(await host.json()).toMatchObject({ allowed: true, lease: expect.any(String) })
    const afterHost = h.runtimeAccessTokenActive.mock.calls.length
    expect((await h.ask(token, { action: "read", sessionId: "ses_1" })).status).toBe(200)
    expect(afterHost).toBeGreaterThan(0)
    expect(h.runtimeAccessTokenActive.mock.calls.length).toBeGreaterThan(afterHost)
    expect(new Set(h.runtimeAccessTokenActive.mock.calls.map(([input]) => JSON.stringify(input)))).toEqual(
      new Set([JSON.stringify({ jti: "rat_owner_1", workspaceId: "ws_1", hostId: "host_machine-1" })]),
    )
    expect(h.authorizeRuntimeSession).toHaveBeenCalledWith(expect.objectContaining({ actorId: "actor_1", sessionId: "ses_1", workspaceId: "ws_1", action: "read" }))
  })

  test("a revoked token is refused", async () => {
    const h = await oracle()
    h.runtimeAccessTokenActive.mockResolvedValue({ active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" })

    const host = await h.ask(await h.mint(), { action: "host_read" })
    const read = await h.ask(await h.mint(), { action: "read", sessionId: "ses_1" })

    expect(host.status).toBe(401)
    expect(await host.json()).toMatchObject({ error: { code: "relay_host_token_invalid" } })
    expect(read.status).toBe(401)
    expect(h.authorizeRuntimeSession).not.toHaveBeenCalled()
  })

  test("refuses a token signed by another key, or one a machine's direct route never admits", async () => {
    const h = await oracle()
    const stranger = await generateKeyPair("EdDSA", { extractable: true })
    const refused = [
      await h.mint({}, stranger.privateKey),
      await h.mint({ sessionId: "ses_1", role: "viewer" }),
      await h.mint({ routingId: "route_1" }),
      await h.mint({ purpose: "turn-execution" }),
      await h.mint({ hostId: sessionHostId("ses_1") }),
      await h.mint({ channelIdentity: { channel: "slack", externalUserId: "U1", identityVersion: 9 } }),
    ]
    for (const token of refused) {
      const answer = await h.ask(token, { action: "host_read" })
      expect(answer.status).toBe(401)
      expect(await answer.json()).toMatchObject({ error: { code: "relay_host_token_invalid" } })
    }
    expect(h.runtimeAccessTokenActive).not.toHaveBeenCalled()
  })
})
