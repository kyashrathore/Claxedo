import { createServer } from "node:http"
import { once } from "node:events"
import { SignJWT, exportJWK, generateKeyPair } from "jose"

// A REAL local JWKS issuer for e2e control-plane fixtures.
//
// This is a SUPPORTED SELF-HOST MODE, not a stub: a request bearing a token
// minted here is verified through the exact same code path as a provider-issued token —
// `controlPlaneAuthContext` (platform/auth/auth.ts:298) calls the injected
// `verifier`, which does real `jose.jwtVerify()` against a real HTTP JWKS
// endpoint and a real EdDSA/ES256 keypair (see `customVerifierAuthAdapter`,
// platform/auth/auth.ts:179 — the same adapter shape self-hosters use to wire
// Auth0/Ory/anything OIDC-shaped, documented as a first-class alternative to
// the signed auth adapter). What it does NOT cover: provider-specific behaviour —
// a real provider's actual token shape, its JWKS rotation cadence, its session-claim
// vocabulary (org role names, template claims). That gap is intentional and
// is covered only by the nightly credentialed `live-*` lane, which runs
// against a real provider test tenant (see `e2e/INVARIANTS.md`).
//
// Shared module so the mint/verify pair is written once. `signed-browser-
// relay-fixture.mjs` is the first consumer (2026-08-06,
// docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md Phase 3); the
// plan's Phase 4 lanes (`desktop-signed-*`, `web-signed-*`) compose a real
// control plane too and should import this instead of hand-rolling a second
// local issuer — that duplication is exactly what the plan's "journey logic
// exists once" gate (Definition of Done) forbids.
export async function startLocalJwksIssuer(input = {}) {
  const algorithm = input.algorithm ?? "EdDSA"
  const kid = input.kid ?? "e2e-local-jwks-1"
  const keypair = await generateKeyPair(algorithm, { extractable: true })
  const publicJwk = { ...(await exportJWK(keypair.publicKey)), kid, alg: algorithm, use: "sig" }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://e2e-local-jwks-issuer.fixture")
    if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ keys: [publicJwk] }))
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found", path: url.pathname }))
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  if (!server.listening) await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local JWKS issuer did not bind")
  const issuer = `http://127.0.0.1:${address.port}`
  const jwksUrl = `${issuer}/.well-known/jwks.json`

  /**
   * Mint a real, signed control-plane bearer token. `claims.subject` becomes
   * the verified identity's `sub` — the SAME value a caller must pass to
   * `createSqliteWorkspaceAuthority`'s methods as `auth.user.subject` for the
   * two to resolve to the identical `token_identifier`
   * (`${issuer}|${subject}`, see `workspace-authority.ts`'s `user()` helper),
   * which is the row-ownership key every role check in that adapter reads.
   */
  async function mint(claims) {
    const now = Math.floor(Date.now() / 1000)
    const ttlSeconds = claims.ttlSeconds ?? 3600
    let jwt = new SignJWT({
      ...(claims.orgId ? { org_id: claims.orgId } : {}),
      ...(claims.extra ?? {}),
    })
      .setProtectedHeader({ alg: algorithm, kid })
      .setIssuer(issuer)
      .setSubject(claims.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
    if (claims.audience) jwt = jwt.setAudience(claims.audience)
    return await jwt.sign(keypair.privateKey)
  }

  return {
    issuer,
    jwksUrl,
    algorithm,
    mint,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
