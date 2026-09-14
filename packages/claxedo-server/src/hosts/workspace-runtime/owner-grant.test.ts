import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { workspaceRuntimeOwnerGrantEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { mintOwnerGrant } from "../../session/owner-grant"
import { workspaceRuntimeOwnerGrant } from "./owner-grant"

const START = 1_700_000_000_000
const scope = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" }

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

describe("the owner grant a cloud root is launched with, as the runtime host holds it", () => {
  test("is absent without one", () => {
    expect(workspaceRuntimeOwnerGrant({})).toBeUndefined()
    expect(workspaceRuntimeOwnerGrant({ WORKSPACE_RUNTIME_OWNER_GRANT: "  " })).toBeUndefined()
  })

  test("names the user it was minted for, serves the token until its expiry, and takes a renewed one in place", async () => {
    const env = await signingEnv()
    let now = START
    const minted = await mintOwnerGrant(scope, env, { now: () => now, ttlSeconds: 600 })
    const grant = workspaceRuntimeOwnerGrant(workspaceRuntimeOwnerGrantEnv({ token: minted.token }), { now: () => now })
    expect(grant?.userId).toBe("alice")
    expect(grant?.expiresAt).toBe(START + 600_000)
    expect(grant?.current()).toBe(minted.token)

    now = START + 600_000
    expect(grant?.current()).toBeUndefined()

    const renewed = await mintOwnerGrant(scope, env, { now: () => now, ttlSeconds: 600 })
    grant?.swap(renewed.token)
    expect(grant?.current()).toBe(renewed.token)
    expect(grant?.expiresAt).toBe(START + 1_200_000)
  })

  test("a token that is not a JWT is served as it is: the control plane is the one that reads it", () => {
    const grant = workspaceRuntimeOwnerGrant({ WORKSPACE_RUNTIME_OWNER_GRANT: "opaque" }, { now: () => START })
    expect(grant?.userId).toBeUndefined()
    expect(grant?.expiresAt).toBeUndefined()
    expect(grant?.current()).toBe("opaque")
  })
})
