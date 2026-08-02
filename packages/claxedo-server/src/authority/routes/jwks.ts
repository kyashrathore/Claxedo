import { Hono } from "hono"
import { exportJWK, importSPKI, type JWK } from "jose"
import { sha256Hex16 } from "../web-crypto"
import {
  RUNTIME_ACCESS_TOKEN_ALGORITHM,
  RuntimeAccessTokenConfigurationError,
  runtimeAccessTokenAlgorithm,
} from "../runtime-access-token"

/**
 * JWKS endpoint for the Runtime Access Token (RAT) signing keys.
 *
 * Publishes the current (and optional next) RAT public keys at
 * `/.well-known/jwks.json`. Verifiers (workspace-relay, etc.) consume this
 * via `jose.createRemoteJWKSet` so the RAT signing key can be rotated
 * without redeploying the relay.
 *
 * The `kid` for each key is either:
 *   - the explicit `CLAXEDO_RUNTIME_ACCESS_TOKEN_KID` /
 *     `CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_KID` env value, or
 *   - SHA-256 of the public key material (`x` for OKP/EC, `n` for RSA),
 *     sliced to the first 16 hex chars (8 bytes).
 *
 * The mint side (`runtime-access-token.ts`) uses the same derivation so the
 * `kid` on a freshly minted RAT always appears in the published JWKS.
 */

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

function pem(input?: string) {
  return clean(input)?.replaceAll("\\n", "\n")
}

async function deriveKid(jwk: JWK): Promise<string> {
  const material = String(jwk.x ?? jwk.n ?? "")
  if (!material) {
    throw new Error("Cannot derive kid: JWK has no public component")
  }
  return await sha256Hex16(material)
}

type KeySource = {
  publicPem: string
  explicitKid?: string
}

type JwksEnv = Record<string, string | undefined>

async function buildJwk(source: KeySource): Promise<JWK> {
  const publicKey = await importSPKI(source.publicPem, RUNTIME_ACCESS_TOKEN_ALGORITHM, { extractable: true })
  const jwk = await exportJWK(publicKey)
  const kid = source.explicitKid ?? await deriveKid(jwk)
  return {
    ...jwk,
    kid,
    alg: RUNTIME_ACCESS_TOKEN_ALGORITHM,
    use: "sig",
  }
}

function collectSources(env: JwksEnv): KeySource[] {
  const sources: KeySource[] = []
  const current = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (current) {
    sources.push({
      publicPem: current,
      explicitKid: clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_KID),
    })
  }
  const next = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM)
  if (next) {
    sources.push({
      publicPem: next,
      explicitKid: clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_KID),
    })
  }
  return sources
}

export function JwksRoutes(env: JwksEnv) {
  const app = new Hono()

  app.get("/.well-known/jwks.json", async (c) => {
    try {
      runtimeAccessTokenAlgorithm(env)
    } catch (error) {
      if (!(error instanceof RuntimeAccessTokenConfigurationError)) throw error
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        500,
      )
    }
    const sources = collectSources(env)
    if (sources.length === 0) {
      return c.json(
        {
          error: {
            code: "jwks_no_keys_configured",
            message: "No RAT public keys are configured for the JWKS endpoint",
          },
        },
        503,
      )
    }
    let keys: JWK[]
    try {
      keys = await Promise.all(sources.map((source) => buildJwk(source)))
    } catch (err) {
      return c.json(
        {
          error: {
            code: "jwks_invalid_key",
            message: "A configured RAT public key is not a valid Ed25519 SPKI PEM",
            detail: err instanceof Error ? err.message : String(err),
          },
        },
        500,
      )
    }
    c.header("cache-control", "public, max-age=300")
    return c.json({ keys })
  })

  return app
}
