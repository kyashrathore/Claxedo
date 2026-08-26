import { createEffect, type Component } from "solid-js"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { usePrincipal } from "@/platform/auth/identity-provider"
import { useConfigOptional } from "@/app/providers/config"
import { group, identify, reset, resolveDeploymentMode, setDeploymentMode } from "@/platform/telemetry/analytics"

/**
 * Binds PostHog identity to the resolved principal. Mounted inside
 * PrincipalProvider, which is the only place the user id and the active org id
 * are composed; reading Clerk directly would miss the anonymous/local kinds.
 */
export const TelemetryIdentityRecorder: Component = () => {
  const platform = usePlatform()
  const config = useConfigOptional()
  const principal = usePrincipal()

  // Both signals are fixed for the life of the shell, so this resolves once on
  // mount rather than through an effect.
  setDeploymentMode(
    resolveDeploymentMode({
      platform: platform.platform,
      authEnabled: config?.authEnabled === true,
    }),
  )

  let last = ""
  let identified = false
  // `identify`, `group` and `reset` are analytics calls, never sources — the
  // compute names the principal and nothing else. The `last` latch stays
  // because the compute yields a fresh object each run.
  createEffect(
    () => {
      const current = principal()
      return {
        userId: current.kind === "signed" || current.kind === "org-member" ? current.userId : undefined,
        orgId: current.kind === "org-member" ? current.orgId : undefined,
      }
    },
    ({ userId, orgId }) => {
      const next = `${userId ?? ""}:${orgId ?? ""}`
      if (next === last) return
      last = next
      if (!userId) {
        // Only a sign-out clears the distinct id; a first render that is merely
        // still anonymous must not reset an id nothing has set yet.
        if (identified) reset()
        identified = false
        return
      }
      identify(userId)
      if (orgId) group("org", orgId)
      identified = true
    },
  )

  return null
}
