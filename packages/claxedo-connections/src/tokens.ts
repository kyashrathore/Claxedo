// Live-token path: key passthrough + oauth refresh-if-expiring with
// single-flight per credential. Failure classification (plan): definitive
// provider rejection persists status "error" (reconnect required — the store
// refuses non-available reads, so persisting error is unrecoverable by
// design); transient failure changes nothing and the next call retries.
// Single-flight is per-process by design; the crash window between a
// provider refresh and the store write is accepted (next refresh fails
// definitively and takes the reconnect path).
import type { IntegrationRegistry } from "./registry.js"
import { OAuth2RequestError } from "./vendor/arctic/request.js"
import {
  ConnectionsUnavailableError,
  connectionProviderId,
  type ConnectionErrorCode,
  type ConnectionRow,
  type ConnectionTokenResponse,
  type CredentialStorePort,
} from "./types.js"

const REFRESH_BUFFER_MS = 5 * 60_000

// Userland oauth impls that don't use the vendored client can throw this to
// signal "reconnect required" (invalid_grant-class) from refresh().
export class DefinitiveRefreshError extends Error {}

export class ConnectionTokenError extends Error {
  status: 403 | 404 | 409 | 503
  code: ConnectionErrorCode | "connection_refresh_transient"
  credentialStatus?: string

  constructor(status: 403 | 404 | 409 | 503, code: ConnectionTokenError["code"], credentialStatus?: string) {
    super(code)
    this.status = status
    this.code = code
    if (credentialStatus !== undefined) this.credentialStatus = credentialStatus
  }
}

type OAuthEnvelope = { access: string; refresh?: string }

function parseEnvelope(secret: string): OAuthEnvelope | undefined {
  try {
    const data = JSON.parse(secret) as { access?: unknown; refresh?: unknown }
    if (typeof data.access !== "string") return undefined
    return { access: data.access, ...(typeof data.refresh === "string" ? { refresh: data.refresh } : {}) }
  } catch {
    return undefined
  }
}

export type TokenDeps = {
  registry: IntegrationRegistry
  credentials: CredentialStorePort
  now?: () => number
}

export function createTokenService(deps: TokenDeps) {
  const now = deps.now ?? Date.now
  const inflight = new Map<string, Promise<void>>()

  async function refreshOnce(integrationId: string, providerId: string, refreshToken: string): Promise<void> {
    const impl = deps.registry.byId(integrationId)?.impl
    if (!impl?.refresh) {
      await deps.credentials.setStatus(providerId, "error", "refresh_failed")
      throw new ConnectionTokenError(409, "connection_not_available", "error")
    }
    try {
      const tokens = await impl.refresh(refreshToken)
      await deps.credentials.put({
        providerId,
        kind: "oauth_token",
        secret: JSON.stringify({
          access: tokens.accessToken,
          // Rotating providers return a new refresh token; others keep the old.
          refresh: tokens.refreshToken ?? refreshToken,
        }),
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      })
    } catch (error) {
      if (error instanceof OAuth2RequestError || error instanceof DefinitiveRefreshError) {
        await deps.credentials.setStatus(providerId, "error", "refresh_failed")
        throw new ConnectionTokenError(409, "connection_not_available", "error")
      }
      throw new ConnectionTokenError(503, "connection_refresh_transient")
    }
  }

  return {
    async getLiveToken(row: ConnectionRow): Promise<ConnectionTokenResponse> {
      const providerId = connectionProviderId(row.id)
      const decl = deps.registry.byId(row.integrationId)?.decl
      let credential
      try {
        credential = await deps.credentials.get(providerId)
      } catch (error) {
        if (error instanceof ConnectionsUnavailableError) throw new ConnectionTokenError(503, "connections_unavailable")
        throw error
      }
      if (!credential) throw new ConnectionTokenError(409, "connection_not_available", "missing")
      if (credential.status !== "available") {
        throw new ConnectionTokenError(409, "connection_not_available", credential.status)
      }

      const readSecret = async () => {
        try {
          return await deps.credentials.resolveSecret(providerId)
        } catch (error) {
          if (error instanceof ConnectionsUnavailableError) throw new ConnectionTokenError(503, "connections_unavailable")
          throw error
        }
      }

      if (credential.kind === "api_key") {
        const secret = await readSecret()
        if (secret === null) throw new ConnectionTokenError(409, "connection_not_available", credential.status)
        return {
          token: secret,
          tokenType: decl?.keyTokenType ?? "bearer",
          ...(Object.keys(row.fields).length ? { fields: row.fields } : {}),
        }
      }

      // oauth_token
      const secret = await readSecret()
      if (secret === null) throw new ConnectionTokenError(409, "connection_not_available", credential.status)
      const envelope = parseEnvelope(secret)
      if (!envelope) throw new ConnectionTokenError(409, "connection_not_available", "error")

      const fresh = credential.expiresAt === undefined || credential.expiresAt - now() > REFRESH_BUFFER_MS
      if (fresh) {
        return { token: envelope.access, tokenType: "bearer" }
      }
      if (!envelope.refresh) {
        await deps.credentials.setStatus(providerId, "error", "refresh_failed")
        throw new ConnectionTokenError(409, "connection_not_available", "error")
      }

      const pending = inflight.get(providerId)
        ?? inflight.set(providerId, refreshOnce(row.integrationId, providerId, envelope.refresh).finally(() => {
          inflight.delete(providerId)
        })).get(providerId)!
      await pending

      const refreshed = await readSecret()
      const refreshedEnvelope = refreshed === null ? undefined : parseEnvelope(refreshed)
      if (!refreshedEnvelope) throw new ConnectionTokenError(409, "connection_not_available", "error")
      return { token: refreshedEnvelope.access, tokenType: "bearer" }
    },
  }
}
