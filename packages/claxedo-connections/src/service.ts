import { createAttempts, type Attempts, type MaybePromise } from "./attempts.js"
import type { IntegrationRegistry } from "./registry.js"
import { ConnectionTokenError, createTokenService } from "./tokens.js"
import {
  connectionProviderId,
  connectionScopeOf,
  type AttemptStatus,
  type ConnectionFields,
  type CodeHostRepository,
  type ConnectionRow,
  type ConnectionScope,
  type ConnectionStorePort,
  type ConnectionSummary,
  type ConnectionTokenResponse,
  type CredentialStorePort,
  type IntegrationCapability,
  type IntegrationDeclaration,
  type VerifyResult,
  type ConnectionTokenFailureCode,
} from "./types.js"

// Credential id written by the removed webhook-secret routes. Retained only
// so that removing a connection also purges signing material a deployment may
// still hold from before that surface was deleted; nothing writes it now.
const orphanedWebhookSigningProviderId = (connectionId: string) =>
  `${connectionProviderId(connectionId)}:webhook-signing`

function declaredNonSecretFields(
  decl: IntegrationDeclaration,
  fields: ConnectionFields,
  canonicalFieldIds: readonly string[] = [],
): ConnectionFields {
  const allowed = new Set([
    ...(decl.prompts ?? []).filter((prompt) => !prompt.secret).map((prompt) => prompt.id),
    ...canonicalFieldIds,
  ])
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)))
}

/**
 * Applies an impl's canonical field values over what the caller typed.
 *
 * The impl's values win — that is the point of the contract — but they go
 * through the SAME declaration filter as caller input, so a buggy or hostile
 * impl cannot smuggle in an undeclared key or shadow a secret prompt by
 * returning it from `verify`. `row.fields` is echoed by `summarize`, so an
 * unfiltered merge here would be a disclosure path, not just untidy state.
 */
function canonicalFields(
  decl: IntegrationDeclaration,
  canonicalFieldIds: readonly string[] | undefined,
  fields: ConnectionFields,
  verified: ConnectionFields | undefined,
): ConnectionFields {
  if (!verified) return fields
  return { ...fields, ...declaredNonSecretFields(decl, verified, canonicalFieldIds) }
}

function requirePersonalOwner(input: { owner?: string; scope?: ConnectionScope }) {
  if (input.scope === "personal" && input.owner === undefined) {
    throw new Error("personal connection scope requires an owner")
  }
}

// Callers that partition the team scope by an opaque key (e.g. a hosted
// deployment's `org:{orgId}`) pass it as `teamOwner`; absent means the
// owner-absent partition is the team — the self-host default, byte-identical.
type PartitionInput = { owner?: string; scope?: ConnectionScope; teamOwner?: string }

export type ConnectResult =
  | { ok: true }
  | { ok: false; code: "unknown_integration" | "connection_exists" | "connection_verify_failed"; reason?: "unauthorized" | "network" }

export type TokenResult =
  | { ok: true; response: ConnectionTokenResponse }
  | { ok: false; status: 403 | 404 | 409 | 503; code: ConnectionTokenFailureCode; credentialStatus?: string }

export type RepositoryListResult =
  | { ok: true; repositories: CodeHostRepository[] }
  | { ok: false; status: 403 | 404 | 409 | 501 | 502 | 503; code: string }

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

  async function summarize(row: ConnectionRow, teamOwner?: string): Promise<ConnectionSummary> {
    const credential = await deps.credentials.get(connectionProviderId(row.id))
    const status: ConnectionSummary["status"] =
      credential === undefined ? "broken" : credential.status === "available" ? "connected" : "degraded"
    return {
      id: row.id,
      integrationId: row.integrationId,
      scope: connectionScopeOf(row.owner, teamOwner),
      ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
      grantedCapabilities: row.grantedCapabilities,
      fields: row.fields,
      status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async function rowsFor(input: PartitionInput = {}) {
    requirePersonalOwner(input)
    // The team partition: the caller-resolved opaque key when present,
    // otherwise the owner-absent partition (self-host default).
    const teamRows = () =>
      input.teamOwner !== undefined
        ? deps.connections.list({ owner: input.teamOwner })
        : deps.connections.list({ owner: null })
    if (input.scope === "team" || input.owner === undefined) return teamRows()
    if (input.scope === "personal") return deps.connections.list({ owner: input.owner })
    return [...(await teamRows()), ...(await deps.connections.list({ owner: input.owner }))]
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
    const providerId = connectionProviderId(id)
    await deps.credentials.put({
      providerId,
      kind: input.kind,
      secret: input.secret,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    // The two ports share no transaction, so the order carries the pairing:
    // the secret is durable before the row that names it, and the row is
    // refused unless the store hands the credential back. A row whose
    // credential is absent answers every token request with
    // `connection_not_available` and no re-verify repairs it — deleting and
    // reconnecting is the only way out, which is worse than a connect that
    // failed outright. Nothing is undone on the way back: an interrupted
    // write leaves at most a secret no route can address, because a provider
    // id is reached only through a row.
    if ((await deps.credentials.get(providerId)) === undefined) {
      throw new Error(`connection credential ${providerId} was not stored`)
    }
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

  /**
   * Persists a completed device grant, naming the account when the impl can.
   *
   * The redirect path stores an unlabelled row because its callback has no
   * token to ask with until after the write. A device grant does, so it names
   * the account up front — an unnamed row is what makes "which GitHub is this?"
   * unanswerable in Settings. A failing `verify` only costs the label: the
   * grant itself is already good, so it must not fail the connect.
   */
  async function storeDeviceGrant(
    pending: { integrationId: string; owner?: string },
    oauthTokens: { accessToken: string; refreshToken?: string; expiresAt?: number },
  ) {
    const entry = deps.registry.byId(pending.integrationId)!
    const verified = await entry.impl.auth?.verify?.({}, oauthTokens.accessToken).catch(() => undefined)
    const accountLabel = verified?.ok ? verified.accountLabel : undefined
    await storeConnection({
      integrationId: pending.integrationId,
      ...(pending.owner !== undefined ? { owner: pending.owner } : {}),
      fields: {},
      ...(accountLabel !== undefined ? { accountLabel } : {}),
      kind: "oauth_token",
      secret: JSON.stringify({
        access: oauthTokens.accessToken,
        ...(oauthTokens.refreshToken !== undefined ? { refresh: oauthTokens.refreshToken } : {}),
      }),
      ...(oauthTokens.expiresAt !== undefined ? { expiresAt: oauthTokens.expiresAt } : {}),
    })
  }

  function capabilityHandle(row: ConnectionRow, capability: IntegrationCapability, teamOwner?: string): CapabilityHandle {
    return {
      id: row.id,
      integrationId: row.integrationId,
      scope: connectionScopeOf(row.owner, teamOwner),
      ...(row.accountLabel !== undefined ? { accountLabel: row.accountLabel } : {}),
      fields: row.fields,
      async getToken() {
        const result = await getToken(row.id, capability)
        if (!result.ok) throw new ConnectionTokenError(result.status, result.code)
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
    const providerId = connectionProviderId(row.id)
    // A caller-asserted report may only take a credential OUT of service.
    // Anything not currently serving — a missing credential, an earlier
    // report, or a host-managed expired/revoked state — is either already
    // refused or a deliberate lifecycle decision a report must not relabel.
    if ((await deps.credentials.get(providerId))?.status !== "available") return
    await deps.credentials.setStatus(providerId, "error", "auth_failure_reported")
  }

  // Resolution seam: `options.owner` here must come from a host-minted,
  // subject-bearing turn credential — never from a runtime-asserted
  // sessionId. A session id is forgeable/guessable on a shared signed host,
  // and a wake-fired turn runs `spawnTurn(sessionId)` into an existing,
  // owned session, so keying resolution off session->owner alone would let
  // an automated turn spend the owner's personal token. Callers must
  // therefore omit `owner` (falling to the team-only path below) whenever
  // they cannot prove the turn was interactively started by that subject.
  // Fail-safe invariant: a propagation bug that drops/loses the owner
  // degrades to "personal connection unused", never to "personal token
  // spent by automation".
  async function resolveForCapability(
    capability: IntegrationCapability,
    options: PartitionInput & { integration?: string } = {},
  ): Promise<CapabilityHandle[]> {
    requirePersonalOwner(options)
    const selected = new Map<string, ConnectionRow>()
    for (const row of await rowsFor(options)) {
      if (!row.grantedCapabilities.includes(capability)) continue
      if (options.integration && row.integrationId !== options.integration) continue
      const current = selected.get(row.integrationId)
      const personalOverTeam =
        current !== undefined &&
        connectionScopeOf(row.owner, options.teamOwner) === "personal" &&
        connectionScopeOf(current.owner, options.teamOwner) === "team"
      if (!current || personalOverTeam) selected.set(row.integrationId, row)
    }
    return [...selected.values()].map((row) => capabilityHandle(row, capability, options.teamOwner))
  }

  // In-flight device polls keyed by attempt state. Polling is what advances
  // the grant, so callers for the same attempt queue here rather than racing
  // `consume` or spending a second upstream request on a mid-consume grant.
  const devicePolls = new Map<string, Promise<unknown>>()

  async function advanceDeviceAttempt(state: string): Promise<{ status: AttemptStatus; integrationId: string; scope: ConnectionScope; message?: string; intervalMs?: number } | undefined> {
    const pending = await attempts.peek(state)
    if (!pending) return attempts.status(state)
    const device = deps.registry.byId(pending.integrationId)?.impl.auth?.device
    if (!device) return attempts.status(state)

    let result
    try {
      result = await device.poll(pending.deviceCode)
    } catch {
      // A failed round-trip is not an answer about the user's choice, so the
      // attempt stays pending and the next poll asks again.
      return attempts.status(state)
    }

    if (result.status === "pending") {
      const status = await attempts.status(state)
      return status && result.intervalMs !== undefined ? { ...status, intervalMs: result.intervalMs } : status
    }
    if (result.status === "denied" || result.status === "expired") {
      // consume() flips `completing` so a concurrent poll cannot settle the
      // same attempt twice.
      if (await attempts.consume(state)) {
        if (result.status === "expired") await attempts.expire(state)
        else await attempts.settle(state, false, "device_denied")
      }
      return attempts.status(state)
    }
    if (!await attempts.consume(state)) return attempts.status(state)
    try {
      await storeDeviceGrant(pending, result.tokens)
      await attempts.settle(state, true)
    } catch {
      await attempts.settle(state, false, "device_store_failed")
    }
    return attempts.status(state)
  }

  return {
    listIntegrations() {
      return deps.registry.list()
    },

    async list(options: PartitionInput = {}): Promise<ConnectionSummary[]> {
      return Promise.all((await rowsFor(options)).map((row) => summarize(row, options.teamOwner)))
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
      if (!entry || !entry.decl.methods.includes("key") || !entry.impl.auth?.verify) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId, input.owner)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const fields = declaredNonSecretFields(entry.decl, input.fields)
      const verified = await entry.impl.auth.verify(fields, input.secret)
      if (!verified.ok) return { ok: false, code: "connection_verify_failed", reason: verified.reason }
      await storeConnection({
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        fields: canonicalFields(entry.decl, entry.impl.auth?.canonicalFields, fields, verified.fields),
        ...(verified.accountLabel !== undefined ? { accountLabel: verified.accountLabel } : {}),
        kind: "api_key",
        secret: input.secret,
      })
      return { ok: true }
    },

    async connectOAuth(input: {
      integrationId: string
      owner?: string
      teamOwner?: string
      attemptRouting?: Record<string, string>
      confirmReplace?: boolean
    }): Promise<
      | { ok: true; url: string; attemptId: string; userCode?: string; intervalMs?: number }
      | { ok: false; code: "unknown_integration" | "connection_exists" }
    > {
      const entry = deps.registry.byId(input.integrationId)
      const redirect = entry?.impl.auth?.authorize && entry.impl.auth?.callback
      const device = entry?.impl.auth?.device
      if (!entry || !entry.decl.methods.includes("oauth") || (!redirect && !device)) {
        return { ok: false, code: "unknown_integration" }
      }
      const existing = await deps.connections.get(input.integrationId, input.owner)
      if (existing && input.confirmReplace !== true) return { ok: false, code: "connection_exists" }
      const scope = connectionScopeOf(input.owner, input.teamOwner)

      // Device grants win where an integration offers both: they need nothing
      // to be able to reach a callback URL, which is the deployment the
      // desktop app and every self-hoster behind NAT actually run in.
      if (device) {
        const grant = await device.start()
        const attempt = await attempts.create({
          integrationId: input.integrationId,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          scope,
          deviceCode: grant.deviceCode,
          ...(input.attemptRouting ? { routing: { ...input.attemptRouting } } : {}),
        })
        return {
          ok: true,
          url: grant.verificationUri,
          attemptId: attempt.state,
          userCode: grant.userCode,
          intervalMs: grant.intervalMs,
        }
      }

      const attempt = await attempts.create({
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        scope,
        ...(entry.impl.auth?.attemptContext ? { context: { ...entry.impl.auth.attemptContext } } : {}),
        ...(input.attemptRouting ? { routing: { ...input.attemptRouting } } : {}),
      })
      const url = await entry.impl.auth!.authorize!(attempt.state, attempt.verifier)
      return { ok: true, url: url.toString(), attemptId: attempt.state }
    },

    /**
     * Advances a device grant by one poll and reports the attempt's status.
     *
     * The redirect flow settles itself when the provider calls back; a device
     * grant has no callback, so SOMETHING has to ask the provider whether the
     * user has finished. That is this. It is safe to call on an
     * already-settled attempt — `peek` returns nothing once the entry is
     * terminal, so a surface that keeps polling after completion re-reads the
     * stored status instead of spending another upstream request.
     *
     * Calls serialize per attempt: overlapped polls would each spend an
     * upstream request and then race `consume` for the same grant. A queued
     * call runs after the earlier one settles and re-reads the attempt, so
     * it answers from the stored status rather than polling again.
     */
    async pollAttempt(state: string): Promise<{ status: AttemptStatus; integrationId: string; scope: ConnectionScope; message?: string; intervalMs?: number } | undefined> {
      const run = (devicePolls.get(state) ?? Promise.resolve()).then(() => advanceDeviceAttempt(state))
      const queued = run.then(() => undefined, () => undefined)
      devicePolls.set(state, queued)
      try {
        return await run
      } finally {
        if (devicePolls.get(state) === queued) devicePolls.delete(state)
      }
    },

    async handleCallback(state: string, code: string | undefined, response?: { issuer?: string }): Promise<{ ok: boolean }> {
      const pending = await attempts.consume(state)
      if (!pending) return { ok: false }
      if (code === undefined) {
        await attempts.settle(state, false, "callback_code_missing")
        return { ok: false }
      }
      const entry = deps.registry.byId(pending.integrationId)
      if (!entry?.impl.auth?.callback) {
        await attempts.settle(state, false, "callback_unsupported")
        return { ok: false }
      }
      try {
      const oauthTokens = await entry.impl.auth.callback(code, pending.verifier, pending.context, response)
      await storeConnection({
        integrationId: pending.integrationId,
        ...(pending.owner !== undefined ? { owner: pending.owner } : {}),
        fields: canonicalFields(entry.decl, entry.impl.auth?.canonicalFields, {}, oauthTokens.fields),
          kind: "oauth_token",
          secret: JSON.stringify({
            access: oauthTokens.accessToken,
            ...(oauthTokens.refreshToken !== undefined ? { refresh: oauthTokens.refreshToken } : {}),
          }),
          ...(oauthTokens.expiresAt !== undefined ? { expiresAt: oauthTokens.expiresAt } : {}),
        })
        await attempts.settle(state, true)
        return { ok: true }
      } catch {
        await attempts.settle(state, false, "callback_failed")
        return { ok: false }
      }
    },

    attemptStatus(state: string): MaybePromise<{ status: AttemptStatus; integrationId: string; scope: ConnectionScope; message?: string } | undefined> {
      return attempts.status(state)
    },

    async remove(id: string): Promise<boolean> {
      const row = await deps.connections.getById(id)
      if (!row) return false
      await deps.credentials.deleteByProvider(connectionProviderId(row.id))
      await deps.credentials.deleteByProvider(orphanedWebhookSigningProviderId(row.id))
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
        await deps.credentials.deleteByProvider(orphanedWebhookSigningProviderId(row.id))
        if (await deps.connections.delete(row.id)) removed++
      }
      return removed
    },

    async reverify(id: string): Promise<VerifyResult | { ok: false; reason: "unsupported" | "missing" }> {
      const row = await deps.connections.getById(id)
      const entry = row ? deps.registry.byId(row.integrationId) : undefined
      if (!entry?.impl.auth?.verify || !row) return { ok: false, reason: entry?.impl.auth?.verify ? "missing" : "unsupported" }
      const providerId = connectionProviderId(row.id)
      const secret = await deps.credentials.readSecret(providerId)
      if (secret === null) return { ok: false, reason: "missing" }
      const verified = await entry.impl.auth.verify(row.fields, secret)
      if (verified.ok) {
        await deps.credentials.setStatus(providerId, "available")
        // Reverify runs the same validation as connect, so it is also the
        // repair path for a row stored before an impl started returning
        // canonical values. Only write when the canonical form actually
        // differs, so a healthy reverify stays a status-only update.
        const canonical = canonicalFields(entry.decl, entry.impl.auth?.canonicalFields, row.fields, verified.fields)
        if (JSON.stringify(canonical) !== JSON.stringify(row.fields)) {
          await deps.connections.upsert({ ...row, fields: canonical, updatedAt: now() })
        }
      }
      return verified
    },

    async listRepositories(id: string): Promise<RepositoryListResult> {
      const row = await deps.connections.getById(id)
      if (!row) return { ok: false, status: 404, code: "connection_not_found" }
      if (!row.grantedCapabilities.includes("code-host")) {
        return { ok: false, status: 403, code: "capability_not_granted" }
      }
      const entry = deps.registry.byId(row.integrationId)
      const codeHost = entry?.impl.actions["code-host"]
      if (!codeHost) {
        return { ok: false, status: 501, code: "repository_listing_unsupported" }
      }
      const token = await getToken(id, "code-host")
      if (!token.ok) return { ok: false, status: token.status, code: token.code }
      try {
        return {
          ok: true,
          repositories: await codeHost.listRepositories(token.response.fields ?? row.fields, token.response.token),
        }
      } catch (error) {
        const code = error instanceof Error && error.message === "github_repositories_unauthorized"
          ? "repository_provider_unauthorized"
          : "repository_provider_unavailable"
        return { ok: false, status: 502, code }
      }
    },

    getToken,
    reportAuthFailure,

    resolveForCapability,

    dispose() {
      attempts.dispose()
    },
  }
}
