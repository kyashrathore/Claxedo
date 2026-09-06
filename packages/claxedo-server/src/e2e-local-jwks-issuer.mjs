import { createServer } from "node:http"
import { once } from "node:events"
import { SignJWT, exportJWK, generateKeyPair } from "jose"

// A real local JWKS issuer for e2e control-plane fixtures: a supported
// self-host mode, not a stub. Tokens minted here are verified through the same
// `jose.jwtVerify()` path as provider-issued ones (`customVerifierAuthAdapter`,
// platform/auth/auth.ts). Provider-specific behaviour — token shape, JWKS
// rotation cadence, session-claim vocabulary — is covered only by the nightly
// credentialed `live-*` lane. Any lane that composes a real control plane
// imports this rather than hand-rolling a second issuer.
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
      ...claims.extra,
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
