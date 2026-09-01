import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useAccountPort } from "@/platform/account/account-provider"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import type { OnboardingFunnelEvent } from "./funnel"
import {
  remoteAccessAvailability,
  remoteAccessClientId,
  remoteAccessDeviceLink,
  remoteAccessAppOrigin,
  type RemoteAccessIdentity,
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
  /**
   * This machine started or stopped publishing.
   *
   * Injected rather than done here, for the same reason `emit` is: what has to
   * be re-read when the machine's publication state changes is the CALLER's
   * knowledge, not this controller's. The workspaces domain owns "which
   * workspaces are published" and onboarding may not import it.
   *
   * It is not optional in practice on any product without a pushing port: the
   * HTTP implementation has no `subscribe`, so without this the published set
   * sits on its stale window and nothing publishes for up to 30 seconds after
   * the user presses Enable.
   */
  onMachineChanged?: () => void
}) {
  const platform = usePlatform()
  const account = useAccountPort()
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
  // Whose machine this is, for the panel's identity row. Derived here rather
  // than at each mount so both surfaces answer identically, and so the
  // "signed but not enriched yet" case has exactly one definition.
  const identity = createMemo<RemoteAccessIdentity>(() => {
    const state = account.state()
    if (state.status === "pending") return { state: "pending" }
    if (state.status !== "signed") return { state: "signed-out" }
    const label = state.identity.displayName ?? state.identity.email
    // Signed with an empty identity means the userinfo enrichment is still in
    // flight. Keep saying "pending" — never the generic word "Account", which
    // reads as "the lookup worked and your name is Account".
    return label ? { state: "named", label } : { state: "pending" }
  })
  // The address a second device opens. A pure function of a baked deployment
  // origin plus this client's own id, so the surface can draw its QR with no
  // round trip — and so the device that follows it can prove it was a second
  // one.
  const deviceLink = createMemo(() => remoteAccessDeviceLink({
    appOrigin: remoteAccessAppOrigin(),
    sourceClientId: remoteAccessClientId(),
  }))
  let resumed = false

  async function enable() {
    const remote = port()
    if (!remote) throw new Error("This build cannot publish a machine for remote access")
    await remote.enable({
      displayName: navigator.platform || "This machine",
      startAtLogin: startAtLogin() ?? false,
    })
    input.emit?.({ name: "remote_access_enabled" })
    input.onMachineChanged?.()
    await Promise.all([status.refetch(), devices.refetch()])
  }

  createEffect(() => {
    if (resumed || platform.platform !== "desktop" || startAtLogin() !== true) return
    if (status.data?.hostedSignedIn !== true || status.data?.enrolled !== true || status.data?.enabled === true) return
    resumed = true
    void enable().catch(() => {
      // The resume can race the connector's own restart (a sign-in bounces
      // the account era, a revoke lands elsewhere) and start() then reports
      // "connector closed". That is not a crash to surface as an unhandled
      // rejection: the panel keeps its explicit Enable button and the status
      // refetch shows the truth. `resumed` stays set on purpose — auto-resume
      // is a one-shot convenience, and retrying it against a failing start is
      // how a laptop hammers the enrollment endpoint unattended.
      void status.refetch()
    })
  })

  // A machine can stop being published without anyone here asking: a heartbeat
  // is rejected, an enrollment expires, the owner revokes it elsewhere. Where a
  // product can say so, the panel is told; where it cannot, this is absent and
  // the query is all there is.
  createEffect(() => {
    const unsubscribe = port()?.subscribe?.(() => {
      void status.refetch()
      input.onMachineChanged?.()
    })
    if (unsubscribe) onCleanup(unsubscribe)
  })

  return {
    status,
    devices,
    availability,
    identity,
    deviceLink,
    startAtLogin: () => startAtLogin() ?? false,
    async setStartAtLogin(enabled: boolean) {
      startAtLoginActions.mutate(enabled)
      await platform.setStartAtLogin?.(enabled)
    },
    enable,
    /**
     * Whether this product can pause at all.
     *
     * Read reactively rather than captured: the desktop binds its port only
     * after account activation, so a capability answered once at mount would
     * be answering for a port that did not exist yet. The surface renders the
     * action only when this is true — a stubbed pause that resolved to nothing
     * would look exactly like a pause that worked.
     */
    canPause: () => port()?.pause !== undefined,
    /** Stop publishing, keeping the machine's identity for a later Enable. */
    async pause() {
      const remote = port()
      if (!remote?.pause) throw new Error("This build cannot pause remote access")
      await remote.pause()
      input.onMachineChanged?.()
      await status.refetch()
    },
    async revoke(hostId: string) {
      const remote = port()
      if (!remote) throw new Error("This build cannot publish a machine for remote access")
      await remote.revoke(hostId)
      input.onMachineChanged?.()
      await Promise.all([status.refetch(), devices.refetch()])
    },
  }
}
