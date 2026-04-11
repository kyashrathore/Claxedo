/**
 * Credential migration — moves legacy plaintext auth from user-agent-config.json
 * into the managed secret backend.
 *
 * Runs once on startup. Idempotent via a migration marker file.
 */

import fs from "fs"
import path from "path"
import { loadUserConfig, saveUserConfig } from "../agent-config"
import { putCredential } from "./registry"
import { getBackend } from "./store"
import { dataDir } from "../paths"
import { Log } from "../log"
import { syncMcpHosts } from "../network/policy"
import type { CredentialKind } from "./types"

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
  // Sandbox providers
  if (providerId === "daytona" || providerId === "modal") return "sandbox_provider"
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
  let dirty = false

  // Migrate provider auth (config.auth)
  if (config.auth) {
    for (const [providerId, secret] of Object.entries(config.auth)) {
      if (!secret?.trim()) continue
      try {
        await putCredential({
          provider_id: providerId,
          kind: credentialKind(providerId),
          source: "managed",
          label: `Migrated from config`,
          secret: secret.trim(),
        })
        migrated.push(providerId)
        log.info("Migrated provider credential", { providerId })
      } catch (err) {
        errors.push(providerId)
        log.error("Failed to migrate provider credential", {
          providerId,
          error: String(err),
        })
      }
    }
    if (migrated.length > 0) {
      config.auth = {}
      dirty = true
    }
  }

  // Migrate sandbox auth (config.sandbox.auth)
  if (config.sandbox?.auth) {
    const sandboxAuth = config.sandbox.auth
    if (sandboxAuth.daytona?.api_key) {
      try {
        await putCredential({
          provider_id: "daytona",
          kind: "sandbox_provider",
          source: "managed",
          label: "Migrated from config",
          secret: sandboxAuth.daytona.api_key,
        })
        migrated.push("daytona")
        log.info("Migrated sandbox credential", { providerId: "daytona" })
      } catch (err) {
        errors.push("daytona")
        log.error("Failed to migrate sandbox credential", { error: String(err) })
      }
    }
    if (sandboxAuth.modal?.token_id && sandboxAuth.modal?.token_secret) {
      try {
        // Store both Modal tokens as a JSON blob
        await putCredential({
          provider_id: "modal",
          kind: "sandbox_provider",
          source: "managed",
          label: "Migrated from config",
          secret: JSON.stringify({
            token_id: sandboxAuth.modal.token_id,
            token_secret: sandboxAuth.modal.token_secret,
          }),
        })
        migrated.push("modal")
        log.info("Migrated sandbox credential", { providerId: "modal" })
      } catch (err) {
        errors.push("modal")
        log.error("Failed to migrate sandbox credential", { error: String(err) })
      }
    }

    if (migrated.includes("daytona") || migrated.includes("modal")) {
      config.sandbox = {
        ...config.sandbox,
        auth: undefined,
      }
      dirty = true
    }
  }

  // Save config without raw secrets
  if (dirty) {
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
