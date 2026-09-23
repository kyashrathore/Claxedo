import { createEffect, type Component } from "solid-js"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { usePrincipal } from "@/platform/auth/identity-provider"
import { useDeploymentPosture } from "@/app/connection/deployment-posture"
import {
  group,
  identify,
  reset,
  resolveDeploymentMode,
  setDeploymentMode,
} from "@/platform/telemetry/analytics"

/**
 * Binds PostHog identity to the resolved principal. Mounted inside
 * PrincipalProvider, which is the only place the user id and the active org id
 * are composed; reading the auth client directly would miss the anonymous/local kinds.
 */
export const TelemetryIdentityRecorder: Component = () => {
  const platform = usePlatform()
  const posture = useDeploymentPosture()
  const principal = usePrincipal()

  // Read once at mount rather than through an effect, because neither input
  // moves under this component: `platform` is fixed for the build, the web
  // entries resolve the declaration into the cache before `render()`, and the
  // desktop renderer — which deliberately does not — resolves its plane from
  // the platform alone.
  setDeploymentMode(
    resolveDeploymentMode({
      platform: platform.platform,
      issuesSessions: posture.issuesSessions() === true,
    }),
  )

  let last = ""
  let identified = false
  createEffect(() => {
    const current = principal()
    const userId =
      current.kind === "signed" || current.kind === "org-member" ? current.userId : undefined
    const orgId = current.kind === "org-member" ? current.orgId : undefined
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
  })

  return null
}
