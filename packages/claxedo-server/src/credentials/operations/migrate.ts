/**
 * Credential migration — moves legacy plaintext auth from user-agent-config.json
 * into the managed secret backend.
 *
 * Runs once on startup. Idempotent via a migration marker file.
 */

import fs from "fs"
import path from "path"
import {
  loadUserConfig,
  sandboxDriverConfig,
  saveUserConfig,
  setSandboxDriverConfig,
} from "../../agent-config"
import { putCredential } from "../registry"
import { getBackend } from "../store"
import { dataDir } from "../../platform/runtime/lib/paths"
import { Log } from "../../platform/runtime/lib/log"
import { syncMcpHosts } from "../../sandbox/network/policy"
import type { CredentialKind } from "../types"
import { sandboxDriverIds } from "@claxedo/sandbox-manager/driver-catalog"

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
  if ((sandboxDriverIds as readonly string[]).includes(providerId)) return "sandbox_driver"
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
    const remainingAuth = { ...config.auth }
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
        delete remainingAuth[providerId]
        log.info("Migrated provider credential", { providerId })
      } catch (err) {
        errors.push(providerId)
        log.error("Failed to migrate provider credential", {
          providerId,
          error: String(err),
        })
      }
    }
    if (Object.keys(remainingAuth).length !== Object.keys(config.auth).length) {
      config.auth = remainingAuth
      dirty = true
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
