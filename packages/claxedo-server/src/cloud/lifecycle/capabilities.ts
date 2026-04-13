/**
 * Provider capability resolution.
 *
 * Maps sandbox provider IDs to their explicit capability flags.
 * This makes lifecycle policy testable without inlining
 * provider-specific assumptions into supervisor code.
 */

import type { SandboxProviderID } from "../types"
import type { ProviderCapabilities } from "../authority-types"

const CAPABILITIES: Record<SandboxProviderID, ProviderCapabilities> = {
  daytona: {
    // stop() preserves filesystem, start() resumes — full persistent lifecycle
    supports_persistent_resume: true,
    supports_filesystem_snapshot: false,
    supports_prepared_images: true,
    supports_explicit_stop: true,
    supports_health_probe: true,
  },
  modal: {
    // terminate() is destructive — no stop/resume cycle
    supports_persistent_resume: false,
    supports_filesystem_snapshot: true,
    supports_prepared_images: true,
    supports_explicit_stop: true,
    supports_health_probe: true,
  },
  vercel: {
    // cannot restart once stopped — sandbox.start() warns and no-ops
    supports_persistent_resume: false,
    supports_filesystem_snapshot: true,
    supports_prepared_images: false,
    supports_explicit_stop: true,
    supports_health_probe: true,
  },
  cloudflare: {
    // state is lost when container sleeps — no persistent resume
    // no explicit stop — containers auto-sleep; adapter stop() is a no-op
    // destroy() is the only lifecycle termination
    supports_persistent_resume: false,
    supports_filesystem_snapshot: true,
    supports_prepared_images: false,
    supports_explicit_stop: false,
    supports_health_probe: true,
  },
}

export function getProviderCapabilities(provider: SandboxProviderID): ProviderCapabilities {
  return CAPABILITIES[provider]
}

/**
 * Build a no-capability set (for testing or unknown providers).
 */
export function noCapabilities(): ProviderCapabilities {
  return {
    supports_persistent_resume: false,
    supports_filesystem_snapshot: false,
    supports_prepared_images: false,
    supports_explicit_stop: false,
    supports_health_probe: false,
  }
}
