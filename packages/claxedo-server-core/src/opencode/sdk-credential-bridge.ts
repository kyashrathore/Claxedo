/** Route the public embedded SDK's providers at Claxedo's credential broker. */
import fs from "node:fs"
import path from "node:path"
import type { ProviderBindingOverlay } from "@claxedo/workspace-runtime/opencode"
import { isProviderUnavailable, projectionRenewalDueAt } from "@claxedo/agent-sdk-runtime"
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
 * A provider the credential broker has no destination for is absent, and its
 * accounts reach the engine not at all: the engine used to receive a plaintext
 * copy of the stored key, which is the channel this design removes.
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
 * Whether a second registry row for the same engine provider replaces the one
 * already written.
 *
 * The map is many-to-one — `anthropic` and `claude-sdk` are both the engine's
 * `anthropic` — and the loop used to keep whichever row came last, so an
 * account marked unavailable disabled a provider another account had bound. A
 * bound row always wins; between two of a kind the registry id that matches the
 * engine's own decides, and every group in the table contains exactly one.
 */
function overridesOverlay(held: ProviderBindingOverlay | undefined, next: ProviderBindingOverlay, exact: boolean) {
  if (!held) return true
  const heldBound = !("unavailable" in held)
  const nextBound = !("unavailable" in next)
  return heldBound === nextBound ? exact : nextBound
}

/**
 * When the engine's placeholders have to be replaced. Held here rather than on
 * a workspace runtime: the engine is one process serving every workspace, so
 * nothing in that map expires alongside it.
 */
let renewAt: number | undefined

/**
 * Re-project the engine's credentials when its earliest placeholder is due, or
 * whenever the caller says the process lost track of time. A cold engine holds
 * no placeholder and needs no renewal.
 */
export async function renewSdkCredentialsIfDue(input: { at: number; all?: boolean }): Promise<void> {
  if (!openCodeSdkRuntimeLoaded()) return
  if (!input.all && (renewAt === undefined || renewAt > input.at)) return
  await reconcileCredentialsIntoSdk()
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

export function sdkProviderFor(providerID: string): string | undefined {
  return PROVIDER_BY_REGISTRY_ID[providerID]
}

export type SdkCredentialSyncResult = Readonly<{ bound: readonly string[]; removed: readonly string[] }>

/**
 * Write-only-when-running. A credential mutation never boots a cold SDK host:
 * when the host is not serving, the registry stays the authority and the boot
 * reconcile (`reconcileCredentialsIntoSdk`, run by the host's boot plugin)
 * carries the current registry across once the SDK actually starts.
 */
export async function syncCredentialsToSdk(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<SdkCredentialSyncResult> {
  if (!openCodeSdkRuntimeLoaded()) return { bound: [], removed: [] }
  return reconcileCredentialsIntoSdk(org)
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
  const auth = await projectRuntimeAuth({
    scope: "local",
    ...(org === SINGLE_TENANT_ORG ? {} : { orgId: org }),
    workspaceId: ENGINE_RUNTIME,
  })
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
  await runtime.bindProviders(overlays)
  renewAt = projectionRenewalDueAt(auth, projectedAt)
  const bound = Object.keys(overlays)
  log.info("OpenCode SDK providers bound to the credential broker", { bound: bound.length, removed: removed.length })
  return { bound, removed }
}

/**
 * Drop the plaintext keys an earlier build connected into the SDK's own
 * credential store. Without this the engine keeps resolving auth from a stored
 * copy of the user's secret and the broker binding is never the value it sends.
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
