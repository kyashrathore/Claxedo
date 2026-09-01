export type RemoteAccessCapability = {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  hostedSignedIn: boolean
  enabled: boolean
  secondDeviceOpen?: boolean
}

export type RemoteAccessAvailability =
  | { state: "locked"; reason: string }
  | { state: "sign-in-required" }
  | { state: "ready-to-enable" }
  | { state: "enabled"; proven: boolean }

export const REMOTE_ACCESS_PHONE_COPY =
  "Monitor running work and reply from your phone. Full mobile editing is not part of this preview."

export function remoteAccessAvailability(input: RemoteAccessCapability): RemoteAccessAvailability {
  if (!input.deviceLoginConfigured && !input.relayConfigured) {
    return {
      state: "locked",
      reason: "Remote access is coming soon. Device sign-in and the hosted relay are not available yet.",
    }
  }
  if (!input.deviceLoginConfigured) {
    return {
      state: "locked",
      reason: "Remote access is coming soon. Device sign-in is not available yet.",
    }
  }
  if (!input.relayConfigured) {
    return {
      state: "locked",
      reason: "Remote access is coming soon. The hosted relay is not available yet.",
    }
  }
  if (!input.hostedSignedIn) return { state: "sign-in-required" }
  if (!input.enabled) return { state: "ready-to-enable" }
  return { state: "enabled", proven: input.secondDeviceOpen === true }
}

/**
 * The origin a phone must open to reach a shared workspace.
 *
 * This is a DEPLOYMENT binding, not a runtime guess: the desktop renderer
 * runs on localhost (dev) or a file/app scheme (packaged), so its own
 * `window.location` never names the hosted app. `VITE_CLAXEDO_APP_ORIGIN` is
 * baked per build the same way the auth flags are — a staging desktop links
 * to the staging app, production to production. The window origin is only
 * trusted for the browser product actually served FROM the hosted app, and
 * the production origin is the final default rather than a hidden fallback.
 *
 * Two surfaces used to carry private copies of this heuristic and both
 * silently linked a staging deployment's QR to production, which renders a
 * blank page there — the workspace does not exist on that control plane.
 */
export function remoteAccessAppOrigin(): string {
  const baked = (import.meta.env?.VITE_CLAXEDO_APP_ORIGIN as string | undefined)?.trim()
  if (baked) return baked
  if (
    typeof window !== "undefined" &&
    /^https?:$/.test(window.location.protocol) &&
    !["localhost", "127.0.0.1"].includes(window.location.hostname)
  ) {
    return window.location.origin
  }
  return "https://app.claxedo.com"
}

export function remoteAccessWorkspaceLink(input: {
  appOrigin: string
  workspaceId: string
  sourceClientId: string
}) {
  const url = new URL(workspaceRoute(input.workspaceId), input.appOrigin)
  url.searchParams.set("claxedo_second_device", "1")
  url.searchParams.set("claxedo_source_client", input.sourceClientId)
  return url.toString()
}

export function shouldRecordSecondDeviceOpen(input: {
  url: URL
  currentClientId: string
  signedIn: boolean
}) {
  if (!input.signedIn || input.url.searchParams.get("claxedo_second_device") !== "1") return false
  const sourceClientId = input.url.searchParams.get("claxedo_source_client")
  return !!sourceClientId && sourceClientId !== input.currentClientId
}

export function remoteAccessClientId(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const key = "claxedo.remote-access.client-id"
  const existing = storage.getItem(key)?.trim()
  if (existing) return existing
  const id = crypto.randomUUID()
  storage.setItem(key, id)
  return id
}
import { workspaceRoute } from "@/platform/identity/route"
