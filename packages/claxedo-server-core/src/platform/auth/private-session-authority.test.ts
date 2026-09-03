import { describe, expect, test } from "vitest"
import {
  PRIVATE_SESSION_AUTHORITY_METHODS,
  privateSessionRuntimeProof,
  type RelayHostPrivateSessionClaims,
} from "./private-session-authority"

const claims: RelayHostPrivateSessionClaims = {
  principal_kind: "user",
  actor_id: "actor_alice",
  actor_kind: "human",
  org_id: "org_acme",
  workspace_id: "workspace_main",
  host_id: "host_main",
  jti: "rht_child",
  parent_jti: "rat_parent",
}

describe("provider-neutral private-session authority contract", () => {
  test("publishes one exact adapter method inventory", () => {
    expect(PRIVATE_SESSION_AUTHORITY_METHODS).toEqual([
      "reserveSession",
      "registerRuntimeSession",
      "markSessionRegistrationAmbiguous",
      "beginSessionCompensation",
      "completeSessionCompensation",
      "authorizeSessionRead",
      "authorizeSessionWrite",
      "authorizeRuntimeSession",
      "grantSessionParticipant",
      "revokeSessionParticipant",
      "listSessions",
      "resolveSession",
      "readSessionMessages",
      "syncSessionMessages",
      "upsertSessionVisibility",
      "replaceSessionVisibility",
      "deleteSessionVisibility",
    ])
  })

  test("keeps the RHT child and RAT parent identities distinct without a provider subject", () => {
    expect(privateSessionRuntimeProof(claims)).toEqual({
      principalKind: "user",
      actorId: "actor_alice",
      actorKind: "human",
      orgId: "org_acme",
      workspaceId: "workspace_main",
      hostId: "host_main",
      relayHostTokenJti: "rht_child",
      parentRuntimeAccessTokenJti: "rat_parent",
    })
    expect(privateSessionRuntimeProof(claims)).not.toHaveProperty("subject")
  })

  test("rejects absent parent authority and inconsistent principal kinds", () => {
    expect(() => privateSessionRuntimeProof({ ...claims, parent_jti: " " })).toThrow("parent_jti claim is required")
    expect(() =>
      privateSessionRuntimeProof({
        ...claims,
        principal_kind: "service",
        actor_kind: "human",
      } as RelayHostPrivateSessionClaims),
    ).toThrow("principal and actor kinds are inconsistent")
    expect(() =>
      privateSessionRuntimeProof({
        ...claims,
        principal_kind: "provider-subject",
      } as unknown as RelayHostPrivateSessionClaims),
    ).toThrow("principal and actor kinds are inconsistent")
  })
})
