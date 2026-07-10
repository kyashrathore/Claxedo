import { createAttempts, type Attempts } from "./attempts.js"
import type { IntegrationRegistry } from "./registry.js"
import { ConnectionTokenError, createTokenService } from "./tokens.js"
import {
  ConnectionsUnavailableError,
  connectionProviderId,
  type AttemptStatus,
  type ConnectionFields,
  type ConnectionRow,
  type ConnectionScope,
  type ConnectionStorePort,
  type ConnectionSummary,
  type ConnectionTokenResponse,
  type CredentialStorePort,
  type IntegrationCapability,
  type IntegrationDeclaration,
  type VerifyResult,
} from "./types.js"

function declaredNonSecretFields(decl: IntegrationDeclaration, fields: ConnectionFields): ConnectionFields {
  const allowed = new Set((decl.prompts ?? []).filter((prompt) => !prompt.secret).map((prompt) => prompt.id))
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)))
}

function requirePersonalOwner(input: { owner?: string; scope?: ConnectionScope }) {
  if (input.scope === "personal" && input.owner === undefined) {
    throw new Error("personal connection scope requires an owner")
  }
}

export type ConnectResult =
  | { ok: true }
  | { ok: false; code: "unknown_integration" | "connection_exists" | "connection_verify_failed"; reason?: "unauthorized" | "network" }

export type TokenResult =
  | { ok: true; response: ConnectionTokenResponse }
  | { ok: false; status: 403 | 404 | 409 | 503; code: string; credentialStatus?: string }

export type CapabilityHandle = {
  id: string
  integrationId: string
  scope: ConnectionScope
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
  newId: () => string
  now?: () => number
  attempts?: Attempts
}) {
  const now = deps.now ?? Date.now
  const attempts = deps.attempts ?? createAttempts({ now })
  const tokens = createTokenService({ registry: deps.registry, credentials: deps.credentials, now })

  async function summarize(row: ConnectionRow): Promise<ConnectionSummary> {
    let status: ConnectionSummary["status"] = "broken"
    try {
      const credential = await deps.credentials.get(connectionProviderId(row.id))
      status = credential === undefined ? "broken" : credential.status === "available" ? "connected" : "degraded"
    } catch (error) {
      if (!(error instanceof ConnectionsUnavailableError)) throw error
    }
    return {
      id: row.id,
      integrationId: row.integrationId,
      scope: row.owner === undefined ? "team" : "personal",
      ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
      grantedCapabilities: row.grantedCapabilities,
      fields: row.fields,
      status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async function rowsFor(input: { owner?: string; scope?: ConnectionScope } = {}) {
    requirePersonalOwner(input)
    if (input.scope === "team" || input.owner === undefined) return deps.connections.list({ owner: null })
    if (input.scope === "personal") return deps.connections.list({ owner: input.owner })
    return [
      ...(await deps.connections.list({ owner: null })),
      ...(await deps.connections.list({ owner: input.owner })),
    ]
  }

  async function storeConnection(input: {
    integrationId: string
    owner?: string
    fields: ConnectionFields
    accountLabel?: string
    kind: "api_key" | "oauth_token"
    secret: string
    expiresAt?: number
  }) {
    const decl = deps.registry.byId(input.integrationId)!.decl
    const existing = await deps.connections.get(input.integrationId, input.owner)
    const id = existing?.id ?? deps.newId()
    await deps.credentials.put({
      providerId: connectionProviderId(id),
      kind: input.kind,
      secret: input.secret,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    await deps.connections.upsert({
      id,
      integrationId: input.integrationId,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
      grantedCapabilities: [...decl.capabilities],
      fields: input.fields,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    })
  }

  function capabilityHandle(row: ConnectionRow, capability: IntegrationCapability): CapabilityHandle {
    return {
      id: row.id,
      integrationId: row.integrationId,
      scope: row.owner === undefined ? "team" : "personal",
      ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
      fields: row.fields,
      async getToken() {
        const result = await getToken(row.id, capability)
        if (!result.ok) throw new ConnectionTokenError(result.status, result.code as ConnectionTokenError["code"])
        return result.response
      },
      reportAuthFailure: (reason: string) => reportAuthFailure(row.id, reason),
    }
  }

  async function getToken(id: string, capability: IntegrationCapability | undefined): Promise<TokenResult> {
    const row = await deps.connections.getById(id)
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
  }

  async function reportAuthFailure(id: string, _reason: string): Promise<void> {
    const row = await deps.connections.getById(id)
    if (!row) return
    await deps.credentials.setStatus(connectionProviderId(row.id), "error", "auth_failure_reported")
  }

  async function resolveForCapability(
    capability: IntegrationCapability,
    options: { integration?: string; owner?: string; scope?: ConnectionScope } = {},
  ): Promise<CapabilityHandle[]> {
    requirePersonalOwner(options)
    const selected = new Map<string, ConnectionRow>()
    for (const row of await rowsFor(options)) {
      if (!row.grantedCapabilities.includes(capability)) continue
      if (options.integration && row.integrationId !== options.integration) continue
      const current = selected.get(row.integrationId)
      if (!current || (row.owner !== undefined && current.owner === undefined)) selected.set(row.integrationId, row)
    }
    return [...selected.values()].map((row) => capabilityHandle(row, capability))
  }

  return {
    listIntegrations() {
      return deps.registry.list()
    },

    async list(options: { owner?: string; scope?: ConnectionScope } = {}): Promise<ConnectionSummary[]> {
      return Promise.all((await rowsFor(options)).map(summarize))
    },

    getById(id: string) {
      return deps.connections.getById(id)
    },

    async connect(input: {
      integrationId: string
      owner?: string
      fields: ConnectionFields
      secret: string
      confirmReplace?: boolean
    }): Promise<ConnectResult> {
      const entry = deps.registry.byId(input.integrationId)
      if (!entry || !entry.decl.methods.includes("key") || !entry.impl.verify) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId, input.owner)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const fields = declaredNonSecretFields(entry.decl, input.fields)
      const verified = await entry.impl.verify(fields, input.secret)
      if (!verified.ok) return { ok: false, code: "connection_verify_failed", reason: verified.reason }
      await storeConnection({
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        fields,
        ...(verified.accountLabel !== undefined ? { accountLabel: verified.accountLabel } : {}),
        kind: "api_key",
        secret: input.secret,
      })
      return { ok: true }
    },

    async connectOAuth(input: {
      integrationId: string
      owner?: string
      confirmReplace?: boolean
    }): Promise<{ ok: true; url: string; attemptId: string } | { ok: false; code: "unknown_integration" | "connection_exists" }> {
      const entry = deps.registry.byId(input.integrationId)
      if (!entry || !entry.decl.methods.includes("oauth") || !entry.impl.authorize || !entry.impl.callback) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId, input.owner)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const attempt = attempts.create({
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        scope: input.owner === undefined ? "team" : "personal",
      })
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
          ...(pending.owner !== undefined ? { owner: pending.owner } : {}),
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
        attempts.settle(state, false, "callback_failed")
        return { ok: false }
      }
    },

    attemptStatus(state: string): { status: AttemptStatus; integrationId: string; scope: ConnectionScope; message?: string } | undefined {
      return attempts.status(state)
    },

    async remove(id: string): Promise<boolean> {
      const row = await deps.connections.getById(id)
      if (!row) return false
      await deps.credentials.deleteByProvider(connectionProviderId(row.id))
      return deps.connections.delete(id)
    },

    // Cascade reclaim: delete every personal connection owned by `owner`
    // (and its backing credential). The host calls this when a subject is
    // removed so orphaned personal rows — which owner-mismatch 404s make
    // otherwise unreachable — do not accumulate. Team rows (owner absent)
    // are never matched by a string owner filter, so this cannot touch
    // shared connections. Returns the number of connections removed.
    // Note (v1 accepted-risk): the third-party token is NOT revoked at the
    // provider; the row and credential are deleted locally only.
    async removeOwner(owner: string): Promise<number> {
      if (!owner) return 0
      const rows = await deps.connections.list({ owner })
      let removed = 0
      for (const row of rows) {
        // Defensive: list({owner}) already filters to this owner; never act
        // on a team or foreign-owner row even if a store over-returns.
        if (row.owner !== owner) continue
        await deps.credentials.deleteByProvider(connectionProviderId(row.id))
        if (await deps.connections.delete(row.id)) removed++
      }
      return removed
    },

    async reverify(id: string): Promise<VerifyResult | { ok: false; reason: "unsupported" | "missing" }> {
      const row = await deps.connections.getById(id)
      const entry = row ? deps.registry.byId(row.integrationId) : undefined
      if (!entry?.impl.verify || !row) return { ok: false, reason: entry?.impl.verify ? "missing" : "unsupported" }
      const providerId = connectionProviderId(row.id)
      const secret = await deps.credentials.readSecret(providerId)
      if (secret === null) return { ok: false, reason: "missing" }
      const verified = await entry.impl.verify(row.fields, secret)
      if (verified.ok) await deps.credentials.setStatus(providerId, "available")
      return verified
    },

    getToken,
    reportAuthFailure,

    resolveForCapability,
    forCapability: resolveForCapability,

    dispose() {
      attempts.dispose()
    },
  }
}
