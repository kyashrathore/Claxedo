/**
 * Credential migration — moves legacy plaintext auth from user-agent-config.json
 * into the managed secret backend.
 *
 * Runs once on startup. Idempotent via a migration marker file.
 */

import fs from "fs"
import path from "path"
import {
  legacyPlaintextAuth,
  loadUserConfig,
  sandboxDriverConfig,
  saveUserConfig,
  setSandboxDriverConfig,
} from "@claxedo/server-core/agent-config/index"
import { putCredential } from "@claxedo/server-core/credentials/registry"
import { getBackend } from "@claxedo/server-core/credentials/backend-registry"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { syncMcpHosts } from "@claxedo/server-core/sandbox/network/policy"
import type { CredentialKind } from "@claxedo/server-core/credentials/types"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"

const log = Log.create({ service: "credentials-migrate" })

const MARKER_FILE = path.join(dataDir(), "credentials", ".migrated")

function isAlreadyMigrated() {
  try {
    return fs.existsSync(MARKER_FILE)
  } catch {
    return false
  }
}

function markMigrated() {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true, mode: 0o700 })
    fs.writeFileSync(MARKER_FILE, new Date().toISOString(), { mode: 0o600 })
  } catch (err) {
    log.warn("Failed to write migration marker", { error: String(err) })
  }
}

/** Provider ID → credential kind mapping for legacy auth entries. */
function credentialKind(providerId: string): CredentialKind {
  if (isSandboxDriverID(providerId)) return "sandbox_driver"
  // ACP runners
  if (providerId.endsWith("-acp")) return "api_key"
  // Default to API key
  return "api_key"
}

/**
 * Migrate legacy plaintext credentials into the managed secret backend.
 *
 * Reads `auth` and `sandbox.auth` from user-agent-config.json,
 * stores each secret in the configured backend, and removes the
 * raw values from the config file.
 */
export async function migrateCredentials(): Promise<{ migrated: string[]; errors: string[] }> {
  const migrated: string[] = []
  const errors: string[] = []

  if (isAlreadyMigrated()) {
    log.info("Credential migration already completed")
    return { migrated, errors }
  }

  const backend = getBackend()
  const ok = await backend.probe()
  if (!ok) {
    log.error("Secret backend unavailable — skipping credential migration")
    return { migrated, errors: ["backend_unavailable"] }
  }

  const config = await loadUserConfig()
  // The loader drops the plaintext map, and `saveUserConfig` writes the file
  // without it, so draining it takes a read of the file's own text. An entry
  // this pass could not store stays on disk: the rewrite below is what removes
  // it, and it only happens once every entry is somewhere else.
  const plaintext = await legacyPlaintextAuth()
  let dirty = false
  let strandedPlaintext = false
  for (const [providerId, secret] of Object.entries(plaintext)) {
    if (!secret.trim()) continue
    try {
      await putCredential({
        provider_id: providerId,
        kind: credentialKind(providerId),
        source: "managed",
        label: `Migrated from config`,
        secret: secret.trim(),
      })
      migrated.push(providerId)
      dirty = true
      log.info("Migrated provider credential", { providerId })
    } catch (err) {
      errors.push(providerId)
      strandedPlaintext = true
      log.error("Failed to migrate provider credential", {
        providerId,
        error: String(err),
      })
    }
  }


  const sandboxDriverConfigValue = sandboxDriverConfig(config)

  // Migrate sandbox driver auth from canonical sandbox_driver config.
  if (sandboxDriverConfigValue.auth) {
    const sandboxDriverAuth = sandboxDriverConfigValue.auth
    const remainingAuth = { ...sandboxDriverAuth }
    let migratedSandboxDriverAuth = false

    if (sandboxDriverAuth.daytona?.api_key) {
      try {
        await putCredential({
          provider_id: "daytona",
          kind: "sandbox_driver",
          source: "managed",
          label: "Migrated from config",
          secret: sandboxDriverAuth.daytona.api_key,
        })
        migrated.push("daytona")
        migratedSandboxDriverAuth = true
        delete remainingAuth.daytona
        log.info("Migrated sandbox driver credential", { driverId: "daytona" })
      } catch (err) {
        errors.push("daytona")
        log.error("Failed to migrate sandbox driver credential", { error: String(err) })
      }
    }
    if (sandboxDriverAuth.modal?.token_id && sandboxDriverAuth.modal?.token_secret) {
      try {
        // Store both Modal tokens as a JSON blob
        await putCredential({
          provider_id: "modal",
          kind: "sandbox_driver",
          source: "managed",
          label: "Migrated from config",
          secret: JSON.stringify({
            token_id: sandboxDriverAuth.modal.token_id,
            token_secret: sandboxDriverAuth.modal.token_secret,
          }),
        })
        migrated.push("modal")
        migratedSandboxDriverAuth = true
        delete remainingAuth.modal
        log.info("Migrated sandbox driver credential", { driverId: "modal" })
      } catch (err) {
        errors.push("modal")
        log.error("Failed to migrate sandbox driver credential", { error: String(err) })
      }
    }

    if (
      sandboxDriverAuth.vercel?.access_token &&
      sandboxDriverAuth.vercel.team_id &&
      sandboxDriverAuth.vercel.project_id
    ) {
      try {
        await putCredential({
          provider_id: "vercel",
          kind: "sandbox_driver",
          source: "managed",
          label: "Migrated from config",
          secret: JSON.stringify({
            access_token: sandboxDriverAuth.vercel.access_token,
            team_id: sandboxDriverAuth.vercel.team_id,
            project_id: sandboxDriverAuth.vercel.project_id,
          }),
        })
        migrated.push("vercel")
        migratedSandboxDriverAuth = true
        delete remainingAuth.vercel
        log.info("Migrated sandbox driver credential", { driverId: "vercel" })
      } catch (err) {
        errors.push("vercel")
        log.error("Failed to migrate sandbox driver credential", { error: String(err) })
      }
    }

    if (sandboxDriverAuth.cloudflare?.api_token && sandboxDriverAuth.cloudflare.worker_url) {
      try {
        await putCredential({
          provider_id: "cloudflare",
          kind: "sandbox_driver",
          source: "managed",
          label: "Migrated from config",
          secret: JSON.stringify({
            api_token: sandboxDriverAuth.cloudflare.api_token,
            worker_url: sandboxDriverAuth.cloudflare.worker_url,
          }),
        })
        migrated.push("cloudflare")
        migratedSandboxDriverAuth = true
        delete remainingAuth.cloudflare
        log.info("Migrated sandbox driver credential", { driverId: "cloudflare" })
      } catch (err) {
        errors.push("cloudflare")
        log.error("Failed to migrate sandbox driver credential", { error: String(err) })
      }
    }

    if (migratedSandboxDriverAuth) {
      setSandboxDriverConfig(config, {
        ...sandboxDriverConfigValue,
        auth: Object.keys(remainingAuth).length > 0 ? remainingAuth : undefined,
      })
      dirty = true
    }
  }

  // The rewrite is what takes the plaintext off disk, and it takes ALL of it:
  // one entry the backend refused would be deleted along with the ones it
  // stored. Nothing is written until the next pass can store that entry too.
  if (dirty && !strandedPlaintext) {
    await saveUserConfig(config)
    log.info("Removed plaintext secrets from config", { count: migrated.length })
  }

  if (errors.length === 0) {
    markMigrated()
  }

  // Sync network allowlist for any existing remote MCP servers
  if (config.mcp) {
    syncMcpHosts(config.mcp)
  }

  log.info("Credential migration complete", { migrated, errors })
  return { migrated, errors }
}
