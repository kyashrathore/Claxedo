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

export function remoteAccessWorkspaceLink(input: {
  appOrigin: string
  workspaceId: string
  sourceClientId: string
}) {
  const url = new URL(`/w/${encodeURIComponent(input.workspaceId)}`, input.appOrigin)
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
