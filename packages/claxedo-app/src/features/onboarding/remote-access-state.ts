export type RemoteAccessCapability = {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  hostedSignedIn: boolean
  enabled: boolean
  secondDeviceOpen?: boolean
}

/**
 * Whose machine this is, as the panel may state it.
 *
 * "pending" covers BOTH sign-in in flight and signed-with-no-identity-yet,
 * because both mean the same thing to a reader: we do not know the name yet.
 * There is deliberately no "unknown name" variant carrying a placeholder —
 * printing a generic word where a name belongs reads as a successful lookup.
 */
export type RemoteAccessIdentity =
  | { state: "pending" }
  | { state: "signed-out" }
  | { state: "named"; label: string }

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

/** The two params that identify a link followed from this machine's QR. */
export const SECOND_DEVICE_PARAM = "claxedo_second_device"
export const SECOND_DEVICE_SOURCE_PARAM = "claxedo_source_client"

/** Where a carried-in marker waits until a workspace can be attributed to it. */
export const SECOND_DEVICE_STASH_KEY = "claxedo.remote-access.second-device"

/**
 * The URL a second device opens to reach THIS machine.
 *
 * Machine-level sharing has no single workspace to point at — enabling remote
 * access publishes every local workspace on the machine, including the ones
 * opened afterwards — so the destination is the app root, where the account's
 * workspaces are listed. It is a pure string over a baked deployment origin,
 * which is what lets the surface render its QR with no round trip: there is
 * nothing to ask anyone for.
 *
 * It still carries the two markers, because "someone opened this from another
 * device" is the same fact it always was; only the moment it can be attributed
 * moved. `RemoteAccessMarkerRecorder` holds the marker from this root landing
 * until the first workspace this device opens.
 */
export function remoteAccessDeviceLink(input: { appOrigin: string; sourceClientId: string }) {
  const url = new URL("/", input.appOrigin)
  url.searchParams.set(SECOND_DEVICE_PARAM, "1")
  url.searchParams.set(SECOND_DEVICE_SOURCE_PARAM, input.sourceClientId)
  return url.toString()
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
  if (!input.signedIn || input.url.searchParams.get(SECOND_DEVICE_PARAM) !== "1") return false
  const sourceClientId = input.url.searchParams.get(SECOND_DEVICE_SOURCE_PARAM)
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
