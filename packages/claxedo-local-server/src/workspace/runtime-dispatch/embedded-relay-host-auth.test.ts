import { describe, expect, test } from "vitest"
import {
  EMBEDDED_RELAY_HOST_AUTH_HEADER,
  embeddedRelayHostAuthFromActor,
  parseEmbeddedRelayHostAuthHeader,
} from "./embedded-relay-host-auth"

describe("embedded relay host auth stamp", () => {
  test("builds hop claims from a resolved control-plane actor", () => {
    expect(embeddedRelayHostAuthFromActor({
      actorId: "issuer|user_bob",
      userId: "user_bob",
      actorKind: "human",
      actorPublicId: "usr_bob",
      actorName: "Bob",
      orgId: "org_1",
      role: "editor",
    }, "ws_1")).toEqual({
      principal_kind: "user",
      actor_id: "issuer|user_bob",
      user_id: "user_bob",
      actor_kind: "human",
      actor_public_id: "usr_bob",
      actor_name: "Bob",
      workspace_id: "ws_1",
      org_id: "org_1",
      role: "editor",
    })
  })

  test("round-trips the hop header payload", () => {
    const auth = embeddedRelayHostAuthFromActor({
      actorId: "issuer|user_bob",
      userId: "user_bob",
      actorKind: "human",
      actorPublicId: "usr_bob",
      actorName: "Bob",
      orgId: "org_1",
      role: "editor",
    }, "ws_1")
    expect(parseEmbeddedRelayHostAuthHeader(JSON.stringify(auth))).toEqual(auth)
    expect(EMBEDDED_RELAY_HOST_AUTH_HEADER).toBe("x-claxedo-embedded-relay-host-auth")
  })

  test("carries the one session a share holder's token reaches, and refuses an empty scope", () => {
    const auth = embeddedRelayHostAuthFromActor({
      actorId: "issuer|user_share",
      actorKind: "human",
      actorPublicId: "usr_share",
      actorName: "Share",
      orgId: "org_1",
      role: "viewer",
      sessionId: "ses_shared",
    }, "ws_1")
    expect(auth.session_id).toBe("ses_shared")
    expect(parseEmbeddedRelayHostAuthHeader(JSON.stringify(auth))).toEqual(auth)
    expect(parseEmbeddedRelayHostAuthHeader(JSON.stringify({ ...auth, session_id: " " }))).toBeUndefined()
  })
})
