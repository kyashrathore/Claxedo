/** Route the public embedded SDK's providers at Claxedo's credential broker. */
import fs from "node:fs"
import path from "node:path"
import type { ProviderBindingOverlay } from "@claxedo/workspace-runtime/opencode"
import {
  isProviderUnavailable,
  projectionRenewalDue,
  projectionRenewalDueAt,
  providerProjectionRecord,
} from "@claxedo/agent-sdk-runtime"
import { jsonRecord } from "../platform/runtime/lib/json"
import { projectRuntimeAuth } from "../agent-config/index"
import { SINGLE_TENANT_ORG, type CredentialOrgScope } from "../credentials/registry"
import { dataDir } from "../platform/runtime/lib/paths"
import { Log } from "../platform/runtime/lib/log"
import { openCodeSdkRuntime, openCodeSdkRuntimeLoaded } from "./sdk-runtime"

const log = Log.create({ service: "credentials-opencode-sdk-bridge" })

/**
 * The engine is one process serving every workspace, so its bindings name that
 * process rather than a workspace. A per-workspace identity here would be
 * fiction: every workspace's turn runs in this same engine.
 */
const ENGINE_RUNTIME = "opencode-engine"

/**
 * Registry provider → the engine's own provider id. The engine's Anthropic and
 * OpenAI providers are both configured with a base URL that already reaches the
 * vendor's API root, so a binding's API path belongs in it.
 *
 * A provider the credential broker has no destination for is absent from this
 * table, and its accounts reach the engine not at all — which is the intended
 * answer, because the only other way to hand it one is a plaintext copy of the
 * operator's stored key.
 */
const PROVIDER_BY_REGISTRY_ID: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  "claude-sdk": "anthropic",
  openai: "openai",
  "codex-app-server": "openai",
  openrouter: "openrouter",
  google: "google",
  groq: "groq",
  xai: "xai",
}

/**
 * The process environment variables the engine reads a credential for each
 * bound provider out of.
 *
 * `Integration.connection.active` puts an env connection ahead of nothing else
 * for a provider with no stored credential, and `ModelResolver.load` then
 * substitutes that key for the overlay's placeholder. The engine runs inside
 * the Claxedo server process, whose environment nothing scrubs, so on a machine
 * exporting these the operator's real key is what reaches the broker URL — and
 * the broker refuses it as `runtime_token_required`.
 *
 * Withheld only for providers this reconcile bound: the operator chose an
 * account for those, and every other harness's implicit tier goes on reading
 * the rest of the environment.
 */
const ENGINE_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
}

/** What this process removed, so an account the operator drops hands it back. */
const withheldEnv = new Map<string, string>()

function withholdEngineProviderEnv(providers: readonly string[]) {
  const withhold = new Set(providers.flatMap((providerID) => ENGINE_PROVIDER_ENV[providerID] ?? []))
  for (const [name, value] of withheldEnv) {
    if (withhold.has(name)) continue
    process.env[name] = value
    withheldEnv.delete(name)
  }
  for (const name of withhold) {
    const value = process.env[name]
    if (value === undefined) continue
    withheldEnv.set(name, value)
    delete process.env[name]
  }
}

/**
 * Whether a second registry row for the same engine provider replaces the one
 * already written.
 *
 * The map is many-to-one — `anthropic` and `claude-sdk` are both the engine's
 * `anthropic` — so two rows compete for one overlay and keeping whichever came
 * last lets an account marked unavailable disable a provider another account
 * has bound. A bound row always wins; between two of a kind the registry id
 * that matches the engine's own decides, and every group in the table contains
 * exactly one.
 */
function overridesOverlay(held: ProviderBindingOverlay | undefined, next: ProviderBindingOverlay, exact: boolean) {
  if (!held) return true
  const heldBound = !isProviderUnavailable(held)
  const nextBound = !isProviderUnavailable(next)
  return heldBound === nextBound ? exact : nextBound
}

/**
 * When the engine's placeholders have to be replaced, and whose accounts they
 * are.
 *
 * Held here rather than on a workspace runtime: the engine is one process
 * serving every workspace, so nothing in that map expires alongside it. One
 * entry rather than one per org for the same reason — `bindProviders` installs
 * a single overlay set, so exactly one org's accounts are in force, and
 * renewing under any other one would replace them with a different tenant's.
 */
let renewal: { org: CredentialOrgScope; at?: number } | undefined

/**
 * Re-project the engine's credentials when its earliest placeholder is due, or
 * whenever the caller says the process lost track of time. A cold engine holds
 * no placeholder and needs no renewal.
 */
export async function renewSdkCredentialsIfDue(input: { at: number; all?: boolean }): Promise<void> {
  if (!openCodeSdkRuntimeLoaded()) return
  if (!projectionRenewalDue(input, renewal?.at)) return
  await reconcileCredentialsIntoSdk(renewal?.org ?? SINGLE_TENANT_ORG)
}

const managedLabel = (provider: string) => `Claxedo managed: ${provider}`
const ledgerFile = () => path.join(dataDir(), "opencode-sdk-credentials.json")

type Ledger = Record<string, string[]>

function readLedger(): Ledger {
  const row = (() => {
    try {
      return jsonRecord(JSON.parse(fs.readFileSync(ledgerFile(), "utf8")))
    } catch {
      return undefined
    }
  })()
  if (!row) return {}
  const ledger: Ledger = {}
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) ledger[key] = value.filter((entry) => typeof entry === "string")
  }
  return ledger
}

export type SdkCredentialSyncResult = Readonly<{ bound: readonly string[]; removed: readonly string[] }>

/** Whether a registry provider has a row in the engine's own catalog. */
export function engineBindsProvider(providerId: string): boolean {
  return Object.hasOwn(PROVIDER_BY_REGISTRY_ID, providerId)
}

/**
 * Write-only-when-running. A credential mutation never boots a cold SDK host:
 * when the host is not serving, the registry stays the authority and the boot
 * reconcile (`reconcileCredentialsIntoSdk`, run by the host's boot plugin)
 * carries the current registry across once the SDK actually starts.
 *
 * `providers` names what the mutation touched. Activation and replacement are
 * both scoped to a row's own `provider_id`, so a write to a provider the engine
 * has no row for (Cursor, Pi, a sandbox driver) cannot change what the engine
 * would be handed, and the engine is left alone: the reconcile is a full
 * re-projection plus a read of the engine's credential store, and an engine
 * that cannot answer it would otherwise fail a store that has nothing to do
 * with it. A caller that cannot name the providers reconciles everything.
 */
export async function syncCredentialsToSdk(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
  providers?: readonly string[],
): Promise<SdkCredentialSyncResult> {
  if (!openCodeSdkRuntimeLoaded()) return { bound: [], removed: [] }
  if (providers && !providers.some(engineBindsProvider)) return { bound: [], removed: [] }
  try {
    return await reconcileCredentialsIntoSdk(org)
  } catch (error: unknown) {
    log.error("OpenCode SDK credential sync failed", {
      org,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })
    throw new SdkCredentialSyncError(error)
  }
}

/**
 * The registry write went through and the running engine did not take it, so
 * the next embedded turn runs on the account just replaced. A caller answers
 * this by name: folded into a bare 500 it reads as the switch having failed,
 * which the store says it did not.
 */
export class SdkCredentialSyncError extends Error {
  override readonly cause: unknown
  constructor(cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : String(cause))
    this.name = "SdkCredentialSyncError"
    this.cause = cause
  }
}

/**
 * Reconcile the credential authority into the (booting or running) SDK host.
 *
 * The engine receives broker endpoints and placeholders, never a stored secret.
 * An account that is selected but unusable is carried across as unavailable,
 * which disables that provider in the engine's catalog and refuses a turn on
 * it — the alternative, sending nothing, is what the engine reads as "no
 * account chosen" and answers by running on its own login.
 */
export async function reconcileCredentialsIntoSdk(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<SdkCredentialSyncResult> {
  const runtime = openCodeSdkRuntime()
  const projectedAt = Date.now()
  const projected = await projectRuntimeAuth({
    scope: "local",
    ...(org === SINGLE_TENANT_ORG ? {} : { orgId: org }),
    workspaceId: ENGINE_RUNTIME,
  })
  // This map is this process's own authority rather than a snapshot from
  // another one, so a row that comes out malformed disables its own provider
  // instead of dropping every working account with it.
  const auth = providerProjectionRecord(projected, process.env, { onInvalid: "unavailable" }) ?? {}
  const overlays: Record<string, ProviderBindingOverlay> = {}
  for (const [registryID, providerID] of Object.entries(PROVIDER_BY_REGISTRY_ID)) {
    const projection = auth[registryID]
    if (!projection) continue
    // Carried, not skipped: skipping is indistinguishable from "no account
    // chosen", and the engine answers that by running on its own login.
    const overlay: ProviderBindingOverlay = isProviderUnavailable(projection)
      ? { unavailable: true, reason: projection.reason }
      : { baseURL: `${projection.baseUrl}${projection.apiPath ?? ""}`, apiKey: projection.placeholder }
    if (!overridesOverlay(overlays[providerID], overlay, registryID === providerID)) continue
    overlays[providerID] = overlay
  }
  const removed = await removeStoredCredentials(runtime)
  const bound = Object.keys(overlays)
  withholdEngineProviderEnv(bound)
  await runtime.bindProviders(overlays)
  const dueAt = projectionRenewalDueAt(auth, projectedAt)
  renewal = { org, ...(dueAt === undefined ? {} : { at: dueAt }) }
  log.info("OpenCode SDK providers bound to the credential broker", { bound: bound.length, removed: removed.length })
  return { bound, removed }
}

/**
 * Drop every plaintext key stored in the SDK's own credential store under this
 * bridge's label. A stored credential resolves ahead of the catalog overlay, so
 * one left behind is what the engine sends and the broker binding never is.
 */
async function removeStoredCredentials(runtime: ReturnType<typeof openCodeSdkRuntime>): Promise<string[]> {
  const ledger = readLedger()
  const integrations = await runtime.configuration.integrations()
  const byID = new Map(integrations.map((integration) => [integration.id, integration]))
  const removed: string[] = []
  for (const provider of new Set([...Object.values(PROVIDER_BY_REGISTRY_ID), ...Object.keys(ledger)])) {
    const owned = new Set([
      ...(ledger[provider] ?? []),
      ...(byID.get(provider)?.connections ?? [])
        .filter((connection) => connection.type === "credential" && connection.label === managedLabel(provider))
        .map((connection) => connection.id),
    ])
    for (const credentialID of owned) {
      await runtime.configuration.removeCredential(credentialID)
      removed.push(provider)
    }
  }
  if (Object.keys(ledger).length) fs.rmSync(ledgerFile(), { force: true })
  return removed
}
