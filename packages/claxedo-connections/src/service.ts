import { createAttempts, type Attempts } from "./attempts.js"
import type { IntegrationRegistry } from "./registry.js"
import { ConnectionTokenError, createTokenService } from "./tokens.js"
import {
  ConnectionsUnavailableError,
  connectionProviderId,
  type AttemptStatus,
  type ConnectionFields,
  type ConnectionRow,
  type ConnectionStorePort,
  type ConnectionSummary,
  type ConnectionTokenResponse,
  type CredentialStorePort,
  type IntegrationCapability,
  type VerifyResult,
} from "./types.js"

export type ConnectResult =
  | { ok: true }
  | { ok: false; code: "unknown_integration" | "connection_exists" | "connection_verify_failed"; reason?: "unauthorized" | "network" }

export type TokenResult =
  | { ok: true; response: ConnectionTokenResponse }
  | { ok: false; status: 403 | 404 | 409 | 503; code: string; credentialStatus?: string }

export type CapabilityHandle = {
  integrationId: string
  accountLabel?: string
  fields: ConnectionFields
  getToken(): Promise<ConnectionTokenResponse>
  reportAuthFailure(reason: string): Promise<void>
}

export type ConnectionsService = ReturnType<typeof createConnectionsService>

export function createConnectionsService(deps: {
  registry: IntegrationRegistry
  credentials: CredentialStorePort
  connections: ConnectionStorePort
  now?: () => number
  attempts?: Attempts
}) {
  const now = deps.now ?? Date.now
  const attempts = deps.attempts ?? createAttempts({ now })
  const tokens = createTokenService({ registry: deps.registry, credentials: deps.credentials, now })

  async function summarize(row: ConnectionRow): Promise<ConnectionSummary> {
    let status: ConnectionSummary["status"] = "broken"
    try {
      const credential = await deps.credentials.get(connectionProviderId(row.integrationId))
      status = credential === undefined ? "broken" : credential.status === "available" ? "connected" : "degraded"
    } catch (error) {
      if (!(error instanceof ConnectionsUnavailableError)) throw error
    }
    return {
      integrationId: row.integrationId,
      ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
      grantedCapabilities: row.grantedCapabilities,
      fields: row.fields,
      status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async function storeConnection(input: {
    integrationId: string
    fields: ConnectionFields
    accountLabel?: string
    kind: "api_key" | "oauth_token"
    secret: string
    expiresAt?: number
  }) {
    const decl = deps.registry.byId(input.integrationId)!.decl
    await deps.credentials.put({
      providerId: connectionProviderId(input.integrationId),
      kind: input.kind,
      secret: input.secret,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    const existing = await deps.connections.get(input.integrationId)
    await deps.connections.upsert({
      integrationId: input.integrationId,
      ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
      // Granted at connect time (plan): keys grant the declaration copy.
      grantedCapabilities: [...decl.capabilities],
      fields: input.fields,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    })
  }

  return {
    listIntegrations() {
      return deps.registry.list()
    },

    async list(): Promise<ConnectionSummary[]> {
      const rows = await deps.connections.list()
      return await Promise.all(rows.map(summarize))
    },

    async connect(input: {
      integrationId: string
      fields: ConnectionFields
      secret: string
      confirmReplace?: boolean
    }): Promise<ConnectResult> {
      const entry = deps.registry.byId(input.integrationId)
      if (!entry || !entry.decl.methods.includes("key") || !entry.impl.verify) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const verified = await entry.impl.verify(input.fields, input.secret)
      if (!verified.ok) return { ok: false, code: "connection_verify_failed", reason: verified.reason }
      await storeConnection({
        integrationId: input.integrationId,
        fields: input.fields,
        ...(verified.accountLabel !== undefined ? { accountLabel: verified.accountLabel } : {}),
        kind: "api_key",
        secret: input.secret,
      })
      return { ok: true }
    },

    async connectOAuth(input: {
      integrationId: string
      confirmReplace?: boolean
    }): Promise<{ ok: true; url: string; attemptId: string } | { ok: false; code: "unknown_integration" | "connection_exists" }> {
      const entry = deps.registry.byId(input.integrationId)
      if (!entry || !entry.decl.methods.includes("oauth") || !entry.impl.authorize || !entry.impl.callback) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const attempt = attempts.create(input.integrationId)
      const url = await entry.impl.authorize(attempt.state, attempt.verifier)
      return { ok: true, url: url.toString(), attemptId: attempt.state }
    },

    async handleCallback(state: string, code: string | undefined): Promise<{ ok: boolean }> {
      const pending = attempts.consume(state)
      if (!pending || code === undefined) return { ok: false }
      const entry = deps.registry.byId(pending.integrationId)
      if (!entry?.impl.callback) {
        attempts.settle(state, false, "callback_unsupported")
        return { ok: false }
      }
      try {
        const oauthTokens = await entry.impl.callback(code, pending.verifier)
        await storeConnection({
          integrationId: pending.integrationId,
          fields: {},
          kind: "oauth_token",
          secret: JSON.stringify({
            access: oauthTokens.accessToken,
            ...(oauthTokens.refreshToken !== undefined ? { refresh: oauthTokens.refreshToken } : {}),
          }),
          ...(oauthTokens.expiresAt !== undefined ? { expiresAt: oauthTokens.expiresAt } : {}),
        })
        attempts.settle(state, true)
        return { ok: true }
      } catch {
        // Closed reason — provider error bodies can embed sensitive material.
        attempts.settle(state, false, "callback_failed")
        return { ok: false }
      }
    },

    attemptStatus(state: string): { status: AttemptStatus; integrationId: string; message?: string } | undefined {
      return attempts.status(state)
    },

    async remove(integrationId: string): Promise<boolean> {
      const removed = await deps.connections.delete(integrationId)
      if (removed) await deps.credentials.deleteByProvider(connectionProviderId(integrationId))
      return removed
    },

    async reverify(integrationId: string): Promise<VerifyResult | { ok: false; reason: "unsupported" | "missing" }> {
      const entry = deps.registry.byId(integrationId)
      const row = await deps.connections.get(integrationId)
      if (!entry?.impl.verify || !row) return { ok: false, reason: entry?.impl.verify ? "missing" : "unsupported" }
      const providerId = connectionProviderId(integrationId)
      const secret = await deps.credentials.readSecret(providerId)
      if (secret === null) return { ok: false, reason: "missing" }
      const verified = await entry.impl.verify(row.fields, secret)
      if (verified.ok) await deps.credentials.setStatus(providerId, "available")
      return verified
    },

    async reportAuthFailure(integrationId: string, _reason: string): Promise<void> {
      await deps.credentials.setStatus(connectionProviderId(integrationId), "error", "auth_failure_reported")
    },

    async getToken(integrationId: string, capability: IntegrationCapability | undefined): Promise<TokenResult> {
      const row = await deps.connections.get(integrationId)
      if (!row) return { ok: false, status: 404, code: "connection_not_found" }
      if (!capability || !row.grantedCapabilities.includes(capability)) {
        return { ok: false, status: 403, code: "capability_not_granted" }
      }
      try {
        return { ok: true, response: await tokens.getLiveToken(row) }
      } catch (error) {
        if (error instanceof ConnectionTokenError) {
          return {
            ok: false,
            status: error.status,
            code: error.code,
            ...(error.credentialStatus !== undefined ? { credentialStatus: error.credentialStatus } : {}),
          }
        }
        throw error
      }
    },

    async forCapability(
      capability: IntegrationCapability,
      opts: { integration?: string } = {},
    ): Promise<CapabilityHandle[]> {
      const rows = await deps.connections.list()
      const self = this
      return rows
        .filter((row) => row.grantedCapabilities.includes(capability))
        .filter((row) => !opts.integration || row.integrationId === opts.integration)
        .map((row) => ({
          integrationId: row.integrationId,
          ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
          fields: row.fields,
          async getToken() {
            const result = await self.getToken(row.integrationId, capability)
            if (!result.ok) throw new ConnectionTokenError(result.status, result.code as ConnectionTokenError["code"])
            return result.response
          },
          reportAuthFailure: (reason: string) => self.reportAuthFailure(row.integrationId, reason),
        }))
    },

    dispose() {
      attempts.dispose()
    },
  }
}
