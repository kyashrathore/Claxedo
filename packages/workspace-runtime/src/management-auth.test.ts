import { afterEach, expect, test, mock, spyOn } from "bun:test"
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { createWorkspaceRuntimeJwtManagementAuth, loadWorkspaceRuntimeManagementVerificationKey } from "./management-auth"

afterEach(() => mock.restore())

async function signedToken(key: CryptoKey) {
  return new SignJWT({ workspace_id: "ws_a", host_id: "host_a", action: "runtime.config.apply" })
    .setProtectedHeader({ alg: "EdDSA", kid: "management" })
    .setIssuer("control-plane").setAudience("runtime").setSubject("supervisor")
    .setIssuedAt().setExpirationTime("1m").sign(key)
}

async function verify(key: Awaited<ReturnType<typeof loadWorkspaceRuntimeManagementVerificationKey>>, token: string) {
  return createWorkspaceRuntimeJwtManagementAuth({ key, issuer: "control-plane", audience: "runtime" }).authorize({
    request: new Request("http://runtime.test/api/wr/config", { headers: { "x-workspace-runtime-management-token": token } }),
    action: "runtime.config.apply", target: { workspaceId: "ws_a", hostId: "host_a" }, method: "POST", path: "/api/wr/config",
  })
}

test.each([
  "http://keys.example.test/jwks", "http://localhost/jwks", "http://127.0.0.1/jwks", "http://[::1]/jwks",
  "file:///tmp/key.json", "https://user:password@keys.example.test/jwks", "https://keys.example.test/jwks#other",
])("rejects an untrusted management key endpoint before fetching: %s", async (url) => {
  const fetch = spyOn(globalThis, "fetch")
  await expect(loadWorkspaceRuntimeManagementVerificationKey({ WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: url })).rejects.toThrow("Management JWKS requires HTTPS")
  expect(fetch).not.toHaveBeenCalled()
})

test("a configured HTTPS trust anchor validates its own key and refuses another key", async () => {
  const trusted = await generateKeyPair("EdDSA", { extractable: true })
  const other = await generateKeyPair("EdDSA")
  const jwk = { ...await exportJWK(trusted.publicKey), kid: "management" }
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [jwk] }))
  const env = { WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://keys.example.test/jwks" }
  const key = await loadWorkspaceRuntimeManagementVerificationKey(env)
  env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL = "https://other.example.test/jwks"
  expect(await verify(key, await signedToken(trusted.privateKey))).toMatchObject({ ok: true })
  expect(await verify(key, await signedToken(other.privateKey))).toMatchObject({ ok: false, status: 401 })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[0]).toBe("https://keys.example.test/jwks")
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
})

test("a JWKS redirect cannot replace the trust anchor", async () => {
  const trusted = await generateKeyPair("EdDSA")
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example.test/jwks" } }))
  const key = await loadWorkspaceRuntimeManagementVerificationKey({ WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://keys.example.test/jwks" })
  expect(await verify(key, await signedToken(trusted.privateKey))).toMatchObject({ ok: false, status: 401 })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
})

test("local management uses a pinned public key without network access", async () => {
  const trusted = await generateKeyPair("EdDSA", { extractable: true })
  const other = await generateKeyPair("EdDSA")
  const fetch = spyOn(globalThis, "fetch")
  const key = await loadWorkspaceRuntimeManagementVerificationKey({ WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: await exportSPKI(trusted.publicKey) })
  expect(await verify(key, await signedToken(trusted.privateKey))).toMatchObject({ ok: true })
  expect(await verify(key, await signedToken(other.privateKey))).toMatchObject({ ok: false, status: 401 })
  expect(fetch).not.toHaveBeenCalled()
})
