/**
 * Registry → embedded-engine auth bridge.
 *
 * Claxedo stores model-provider credentials in its own registry (SQLite
 * metadata + a secret backend). The embedded OpenCode engine resolves auth from
 * an entirely separate store — `OPENCODE_AUTH_CONTENT` if set, else its own
 * `auth.json` under the engine data dir (packages/opencode/src/auth/index.ts).
 * Nothing connected the two, so a key stored in the app never reached the
 * engine and every turn failed with whatever auth the engine happened to hold.
 *
 * MECHANISM
 * ---------
 * We drive the engine's OWN control routes through the in-process transport:
 *
 *   PUT    /auth/:providerID   { type: "api", key }
 *   DELETE /auth/:providerID
 *
 * (packages/opencode/src/server/routes/instance/httpapi/groups/control.ts).
 * That route decodes the payload against the engine's `Auth.Info` schema and
 * calls the engine's own `auth.set`/`auth.remove`, so writes go through the
 * engine's file handling and 0600 permissions rather than us guessing at its
 * on-disk format. Writing `auth.json` ourselves would bypass that schema check
 * and hard-code a path the engine is free to move.
 *
 * WHY A DISPOSE FOLLOWS EVERY WRITE
 * ---------------------------------
 * `Auth.all()` re-reads per call (no cache), but the PROVIDER layer is what
 * consumes auth, and it caches: provider state is built once per directory in
 * an `InstanceState` ScopedCache with infinite capacity
 * (packages/opencode/src/provider/provider.ts:1317), which reads `auth.all()`
 * once at line 1505 and turns `{type:"api"}` entries into the SDK's `apiKey`
 * option (line 1690). Nothing in the engine invalidates that cache when auth
 * changes — `InstanceState.invalidate` has no callers. So a bare `auth.set` on
 * a running engine updates the file and changes nothing about the next turn,
 * which is exactly the "I updated my key and it still fails" symptom. We follow
 * every write with POST /global/dispose, the engine's own supported teardown
 * (it is what a global config change triggers, handlers/global.ts:88); the next
 * request rebuilds instance state and re-reads auth.
 *
 * ENV SHADOW
 * ----------
 * `Auth.all()` returns `OPENCODE_AUTH_CONTENT` verbatim when set, ignoring the
 * file — a bridged write would then be silently inert. No claxedo-server or
 * desktop source sets that variable in its own process (only spawned harness
 * processes get it), but an operator could. We detect it and warn once rather
 * than reporting a successful sync that cannot take effect.
 */

import fs from "node:fs"
import path from "node:path"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "../opencode-engine"
import { dataDir } from "../paths"
import { Log } from "../log"
import { listCredentials, resolveSecret, SINGLE_TENANT_ORG, type CredentialOrgScope } from "./registry"
import type { CredentialMetadata } from "./types"

const log = Log.create({ service: "credentials-engine-bridge" })

/**
 * Registry provider ids the embedded engine can actually use, mapped to the
 * engine provider id that consumes them.
 *
 * Deliberately an ALLOWLIST, matching the fanout allowlist in registry.ts. The
 * engine runs neither cursor nor the ACP runners, and sandbox/integration/
 * channel credentials must never be handed to a model provider. A new registry
 * id therefore reaches the engine only when someone adds it here on purpose.
 *
 * `claude-sdk`/`claude-acp` and `codex-acp` are the ids the harness credential
 * flows write for what is, to the engine, plain `anthropic`/`openai` auth; they
 * map onto the engine provider so a key connected through those surfaces still
 * powers embedded turns. A bare `anthropic`/`openai` row always wins over an
 * aliased one for the same engine provider.
 */
const ENGINE_PROVIDER_BY_REGISTRY_ID: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  "claude-sdk": "anthropic",
  "claude-acp": "anthropic",
  openai: "openai",
  "codex-acp": "openai",
  openrouter: "openrouter",
  google: "google",
  groq: "groq",
  xai: "xai",
}

/**
 * Kinds that carry auth the engine can present as a provider key.
 *
 * `subscription_session` is deliberately absent: a Claude Pro/Max session is
 * not an API key, and the engine's provider layer would hand it to the SDK as
 * one. It reaches the harnesses that can actually use it through the existing
 * spawn fanout, not through this bridge.
 */
const BRIDGEABLE_KINDS = new Set<CredentialMetadata["kind"]>(["api_key", "oauth_token"])

export function engineProviderFor(providerId: string): string | undefined {
  return ENGINE_PROVIDER_BY_REGISTRY_ID[providerId]
}

export function bridgeable(credential: Pick<CredentialMetadata, "provider_id" | "kind" | "status">): boolean {
  if (!BRIDGEABLE_KINDS.has(credential.kind)) return false
  if (credential.status !== "available") return false
  return engineProviderFor(credential.provider_id) !== undefined
}

/**
 * Providers this bridge manages — the engine entries it is allowed to write or
 * remove. Auth the user set directly in the engine for any OTHER provider is
 * never touched (see the precedence note on `syncCredentialsToEngine`).
 */
export function managedEngineProviders(): ReadonlySet<string> {
  return new Set(Object.values(ENGINE_PROVIDER_BY_REGISTRY_ID))
}

/**
 * Providers THIS bridge has written into the engine, persisted across restarts.
 *
 * Removal cannot key off `managedEngineProviders()` alone. Those ids are the
 * ones the registry is *allowed* to manage, not the ones it has actually
 * written — so an unconditional sweep would delete an `openai` key the user
 * connected directly in the engine's model picker the first time they stored an
 * unrelated anthropic key. That is the same class of bug this bridge fixes,
 * pointed the other way. We only ever remove an entry we put there.
 */
const ledgerFile = () => path.join(dataDir(), "engine-auth-bridge.json")

function readLedger(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), "utf8")) as unknown
    if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is string => typeof item === "string"))
  } catch {}
  return new Set()
}

function writeLedger(providers: Set<string>) {
  try {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true })
    fs.writeFileSync(ledgerFile(), JSON.stringify([...providers].sort()), { mode: 0o600 })
  } catch (error) {
    // A lost ledger costs a stale engine entry on the next delete, not a
    // failed credential write — never fail the sync over it.
    log.warn("failed to persist engine auth bridge ledger", { error: String(error) })
  }
}

let warnedEnvShadow = false

function envShadowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const shadow = env.OPENCODE_AUTH_CONTENT
  if (!shadow) return false
  if (!warnedEnvShadow) {
    warnedEnvShadow = true
    log.warn(
      "OPENCODE_AUTH_CONTENT is set in this process, so the embedded engine ignores its auth file — bridged credentials will NOT take effect until it is unset",
    )
  }
  return true
}

async function engineFetch(pathname: string, init: RequestInit): Promise<boolean> {
  const response = await opencodeRequest(new Request(new URL(pathname, OPENCODE_INTERNAL_BASE), init))
  // The engine returns 200 with a boolean body. Any non-2xx is a real failure
  // (bad payload shape, engine unavailable) and must not be reported as synced.
  if (!response.ok) {
    log.warn("engine auth request failed", { pathname, status: response.status })
    return false
  }
  return true
}

async function setEngineAuth(engineProvider: string, key: string): Promise<boolean> {
  return engineFetch(`/auth/${encodeURIComponent(engineProvider)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    // `{type:"api", key}` is the ONLY Auth.Info variant the engine's provider
    // layer turns into an SDK apiKey for a provider without a plugin auth
    // loader (provider.ts:1510). anthropic has no such loader, so an "oauth"
    // entry would decode fine and then be ignored at model construction.
    body: JSON.stringify({ type: "api", key }),
  })
}

async function removeEngineAuth(engineProvider: string): Promise<boolean> {
  return engineFetch(`/auth/${encodeURIComponent(engineProvider)}`, { method: "DELETE" })
}

/**
 * Drop cached per-directory instance state so the next request rebuilds
 * providers against the auth we just wrote. Without this the write is invisible
 * to a running engine until restart.
 */
async function disposeEngineInstances(): Promise<boolean> {
  return engineFetch("/global/dispose", { method: "POST" })
}

export type EngineAuthSyncResult = {
  /** Engine providers written. */
  synced: string[]
  /** Engine providers removed because the registry no longer has a credential. */
  removed: string[]
  /** True when OPENCODE_AUTH_CONTENT makes the write inert. */
  shadowed: boolean
}

/**
 * Reconcile every bridgeable registry credential into the embedded engine.
 *
 * PRECEDENCE (deliberate, and the reason this is a reconcile rather than a
 * one-way write): the registry is authoritative for the providers it manages —
 * the ids in `ENGINE_PROVIDER_BY_REGISTRY_ID`. For those providers a registry
 * entry overwrites whatever the engine held, and the ABSENCE of a registry
 * entry removes the engine's entry. For every other provider the engine file
 * stays untouched, so a key the user connected directly in the engine (a
 * provider Claxedo has no row for) survives every sync.
 *
 * There is no cross-store timestamp to compare — the engine's auth.json records
 * no write time — so "newest wins" is not implementable without inventing one.
 * Registry-wins-for-managed-providers is the defensible rule: the app's own
 * credential UI is the surface the user just used, and the alternative
 * (engine-wins) reproduces exactly the bug this fixes.
 */
export async function syncCredentialsToEngine(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<EngineAuthSyncResult> {
  const shadowed = envShadowed()
  const result: EngineAuthSyncResult = { synced: [], removed: [], shadowed }

  const candidates = listCredentials(org).filter(bridgeable)

  // One credential per ENGINE provider. Two registry rows can target the same
  // engine provider (`anthropic` and `claude-sdk`); prefer the row whose id is
  // the engine provider's own name, then the most recently updated.
  const chosen = new Map<string, CredentialMetadata>()
  for (const credential of candidates) {
    const engineProvider = engineProviderFor(credential.provider_id)!
    const existing = chosen.get(engineProvider)
    if (!existing) {
      chosen.set(engineProvider, credential)
      continue
    }
    // The registry id that matches the engine provider's own name is the
    // canonical row; aliases only fill in when it is absent.
    if (existing.provider_id === engineProvider) continue
    if (credential.provider_id === engineProvider || credential.updated_at > existing.updated_at) {
      chosen.set(engineProvider, credential)
    }
  }

  let changed = false
  const ledger = readLedger()

  for (const [engineProvider, credential] of chosen) {
    const secret = await resolveSecret(credential.provider_id, credential.kind, org).catch(() => null)
    if (!secret) {
      log.warn("bridgeable credential has no resolvable secret", {
        provider_id: credential.provider_id,
        engine_provider: engineProvider,
      })
      continue
    }
    // `.trim()` before writing: a key pasted with a trailing newline is sent
    // verbatim as a header value and rejected by the provider.
    if (await setEngineAuth(engineProvider, secret.trim())) {
      result.synced.push(engineProvider)
      ledger.add(engineProvider)
      changed = true
    }
  }

  // Remove engine entries THIS bridge previously wrote whose registry
  // credential is gone, so deleting a credential in Claxedo revokes it for the
  // engine — without touching auth the user set in the engine directly.
  for (const engineProvider of [...ledger]) {
    if (chosen.has(engineProvider)) continue
    if (await removeEngineAuth(engineProvider)) {
      result.removed.push(engineProvider)
      ledger.delete(engineProvider)
      changed = true
    }
  }

  if (changed) {
    writeLedger(ledger)
    await disposeEngineInstances()
  }

  log.info("engine auth synced", {
    synced: result.synced.length,
    removed: result.removed.length,
    shadowed,
  })

  return result
}

/**
 * Fire-and-forget sync for credential mutation paths. A bridge failure must
 * never fail the store/delete the user asked for — the credential is safely
 * persisted either way, and the next mutation (or engine boot) reconciles.
 */
export function scheduleEngineAuthSync(org: CredentialOrgScope = SINGLE_TENANT_ORG): void {
  void syncCredentialsToEngine(org).catch((error) => {
    log.warn("engine auth sync failed", { error: String(error) })
  })
}

/** TEST-ONLY: reset the once-per-process env-shadow warning. */
export function __resetEngineBridgeWarningsForTests() {
  warnedEnvShadow = false
}
