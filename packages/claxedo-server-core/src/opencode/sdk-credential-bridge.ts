/** Reconcile Claxedo's credential authority into the public embedded SDK. */
import fs from "node:fs"
import path from "node:path"
import { jsonRecord } from "../platform/runtime/lib/json"
import { listCredentials, resolveSecret, SINGLE_TENANT_ORG, type CredentialOrgScope } from "../credentials/registry"
import type { CredentialMetadata } from "../credentials/types"
import { dataDir } from "../platform/runtime/lib/paths"
import { Log } from "../platform/runtime/lib/log"
import { openCodeSdkRuntime, openCodeSdkRuntimeLoaded } from "./sdk-runtime"

const log = Log.create({ service: "credentials-opencode-sdk-bridge" })
const PROVIDER_BY_REGISTRY_ID: Readonly<Record<string, string>> = {
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
const BRIDGEABLE_KINDS = new Set<CredentialMetadata["kind"]>(["api_key", "oauth_token"])
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

function writeLedger(ledger: Ledger) {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true })
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger), { mode: 0o600 })
}

export function sdkProviderFor(providerID: string): string | undefined {
  return PROVIDER_BY_REGISTRY_ID[providerID]
}

export function sdkBridgeable(credential: Pick<CredentialMetadata, "provider_id" | "kind" | "status">): boolean {
  return credential.status === "available"
    && BRIDGEABLE_KINDS.has(credential.kind)
    && sdkProviderFor(credential.provider_id) !== undefined
}

export type SdkCredentialSyncResult = Readonly<{ synced: readonly string[]; removed: readonly string[] }>

/**
 * Write-only-when-running. A credential mutation never boots a cold SDK host:
 * when the host is not serving, the registry stays the authority and the boot
 * reconcile (`reconcileCredentialsIntoSdk`, run by the host's boot plugin)
 * carries the current registry across once the SDK actually starts.
 */
export async function syncCredentialsToSdk(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<SdkCredentialSyncResult> {
  if (!openCodeSdkRuntimeLoaded()) return { synced: [], removed: [] }
  return reconcileCredentialsIntoSdk(org)
}

/** Reconcile the credential registry into the (booting or running) SDK host. */
export async function reconcileCredentialsIntoSdk(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<SdkCredentialSyncResult> {
  const runtime = openCodeSdkRuntime()
  const chosen = new Map<string, CredentialMetadata>()
  for (const credential of listCredentials(org).filter(sdkBridgeable)) {
    const provider = sdkProviderFor(credential.provider_id)!
    const current = chosen.get(provider)
    if (!current || (current.provider_id !== provider && (
      credential.provider_id === provider || credential.updated_at > current.updated_at
    ))) chosen.set(provider, credential)
  }

  const ledger = readLedger()
  const integrations = await runtime.configuration.integrations()
  const byID = new Map(integrations.map((integration) => [integration.id, integration]))
  const removed: string[] = []
  const synced: string[] = []

  for (const provider of new Set([...Object.values(PROVIDER_BY_REGISTRY_ID), ...Object.keys(ledger)])) {
    const integration = byID.get(provider)
    if (!integration) {
      if (chosen.has(provider)) throw new Error(`OpenCode SDK has no integration for ${provider}`)
      continue
    }
    const owned = new Set([
      ...(ledger[provider] ?? []),
      ...integration.connections
        .filter((connection) => connection.type === "credential" && connection.label === managedLabel(provider))
        .map((connection) => connection.id),
    ])
    for (const credentialID of owned) {
      await runtime.configuration.removeCredential(credentialID)
      removed.push(provider)
    }
    delete ledger[provider]

    const credential = chosen.get(provider)
    if (!credential) continue
    const secret = await resolveSecret(credential.provider_id, credential.kind, org)
    if (!secret?.trim()) throw new Error(`Claxedo credential ${credential.id} has no usable secret`)
    await runtime.configuration.connectKey({
      integrationID: provider,
      key: secret.trim(),
      label: managedLabel(provider),
    })
    const refreshed = (await runtime.configuration.integrations()).find((row) => row.id === provider)
    const ids = refreshed?.connections
      .filter((connection) => connection.type === "credential" && connection.label === managedLabel(provider))
      .map((connection) => connection.id) ?? []
    if (ids.length === 0) throw new Error(`OpenCode SDK did not expose the credential connected for ${provider}`)
    ledger[provider] = ids
    synced.push(provider)
  }

  writeLedger(ledger)
  log.info("OpenCode SDK credentials reconciled", { synced: synced.length, removed: removed.length })
  return { synced, removed }
}
