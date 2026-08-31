import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import type { OnboardingFunnelEvent } from "./funnel"
import {
  remoteAccessAvailability,
  remoteAccessClientId,
  remoteAccessWorkspaceLink,
} from "./remote-access-state"

/**
 * The Remote Access panel's state, over whatever mechanism this product has.
 *
 * This used to build an HTTP client here and call
 * `/api/claxedo/remote-access/*` directly. That is what broke on the desktop:
 * those routes moved to the Host Connector in Electron main, `@claxedo/local-server`
 * serves none of them, and the Enable button kept posting to a 404. A feature
 * naming a product's transport is the bug — it names the operation now, and
 * `platform/remote-access` decides the call.
 *
 * The funnel events live HERE rather than inside either implementation.
 * "Someone completed the remote-access onboarding step" is onboarding's fact,
 * not the transport's, and putting it in one implementation would have left the
 * other silently un-instrumented.
 */
export function useRemoteAccessController(input: {
  serverUrl: string
  /** A hosted account can be entered even before its connector adapter loads. */
  signInAvailable?: () => boolean
  emit?: (event: Extract<OnboardingFunnelEvent, { name: "remote_access_enabled" | "second_device_open" }>) => void
}) {
  const platform = usePlatform()
  // Read per-call rather than captured: a composition root binds at boot, and a
  // module-scope read here would freeze whatever was bound when this module
  // first loaded.
  const port = () => machineRemoteAccess()
  const status = useQuery(() => ({
    queryKey: [
      "claxedo",
      "remote-access",
      "status",
      input.serverUrl,
      input.signInAvailable?.() === true,
    ] as const,
    // The port loads only after desktop account activation. The build's sign-in
    // capability distinguishes that pre-auth state from a product that truly
    // has no remote-access implementation.
    queryFn: async () => {
      const remote = port()
      if (remote) return await remote.status()
      const signInAvailable = input.signInAvailable?.() === true
      return {
        // A signed-capable desktop deliberately loads the connector adapter only
        // after account activation. Before sign-in, the missing port therefore
        // means "authenticate first", not "this feature was not built".
        deviceLoginConfigured: signInAvailable,
        relayConfigured: signInAvailable,
        hostedSignedIn: false,
        enabled: false,
        enrolled: false,
        secondDeviceOpen: false,
      }
    },
    retry: false,
  }))
  const devices = useQuery(() => ({
    queryKey: ["claxedo", "remote-access", "devices", input.serverUrl] as const,
    // Absent `devices` is a capability this product does not have, not an empty
    // account. The desktop knows only about the machine it runs on.
    queryFn: async () => await port()?.devices?.() ?? [],
    enabled: status.data?.hostedSignedIn === true,
    retry: false,
  }))
  const [startAtLogin, startAtLoginActions] = createResource(
    () => platform.platform === "desktop",
    async (desktop) => desktop ? await platform.getStartAtLogin?.() ?? false : false,
  )
  const availability = createMemo(() => remoteAccessAvailability({
    deviceLoginConfigured: status.data?.deviceLoginConfigured === true,
    relayConfigured: status.data?.relayConfigured === true,
    hostedSignedIn: status.data?.hostedSignedIn === true,
    enabled: status.data?.enabled === true,
    secondDeviceOpen: status.data?.secondDeviceOpen === true,
  }))
  const workspaceLink = createMemo(() => {
    const workspaceId = devices.data?.flatMap((device) => device.workspaceIds)[0]
    if (!workspaceId || typeof window === "undefined") return
    const origin = /^https?:$/.test(window.location.protocol) && !["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? window.location.origin
      : "https://app.claxedo.com"
    return remoteAccessWorkspaceLink({
      appOrigin: origin,
      workspaceId,
      sourceClientId: remoteAccessClientId(),
    })
  })
  let resumed = false

  async function enable() {
    const remote = port()
    if (!remote) throw new Error("This build cannot publish a machine for remote access")
    await remote.enable({
      displayName: navigator.platform || "This machine",
      startAtLogin: startAtLogin() ?? false,
    })
    input.emit?.({ name: "remote_access_enabled" })
    await Promise.all([status.refetch(), devices.refetch()])
  }

  createEffect(() => {
    if (resumed || platform.platform !== "desktop" || startAtLogin() !== true) return
    if (status.data?.hostedSignedIn !== true || status.data?.enrolled !== true || status.data?.enabled === true) return
    resumed = true
    void enable()
  })

  // A machine can stop being published without anyone here asking: a heartbeat
  // is rejected, an enrollment expires, the owner revokes it elsewhere. Where a
  // product can say so, the panel is told; where it cannot, this is absent and
  // the query is all there is.
  createEffect(() => {
    const unsubscribe = port()?.subscribe?.(() => {
      void status.refetch()
    })
    if (unsubscribe) onCleanup(unsubscribe)
  })

  return {
    status,
    devices,
    availability,
    workspaceLink,
    startAtLogin: () => startAtLogin() ?? false,
    async setStartAtLogin(enabled: boolean) {
      startAtLoginActions.mutate(enabled)
      await platform.setStartAtLogin?.(enabled)
    },
    enable,
    async revoke(hostId: string) {
      const remote = port()
      if (!remote) throw new Error("This build cannot publish a machine for remote access")
      await remote.revoke(hostId)
      await Promise.all([status.refetch(), devices.refetch()])
    },
  }
}
