import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useAccountPort } from "@/platform/account/account-provider"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import type { RemoteAccessProviderConfig } from "./remote-access-surface"
import {
  remoteAccessAvailability,
  remoteAccessClientId,
  remoteAccessDeviceLink,
  remoteAccessAppOrigin,
  remoteAccessResumeDecision,
  type RemoteAccessIdentity,
} from "./remote-access-state"

/**
 * The Remote Access panel's state, over whatever mechanism this product has.
 *
 * A feature naming a product's transport is the bug: this controller names
 * the operation only, and `platform/remote-access` decides the call — the
 * desktop's Host Connector, an HTTP client, or anything else a future product
 * adds.
 */
export function useRemoteAccessController(input: {
  serverUrl: string
  /** A hosted account can be entered even before its connector adapter loads. */
  signInAvailable?: () => boolean
  /**
   * This machine started or stopped publishing.
   *
   * Injected rather than done here: what has to be re-read when the machine's
   * publication state changes is the caller's knowledge, not this
   * controller's. The workspaces domain owns "which workspaces are published"
   * and a feature may not import another feature.
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
  const providerConfig = useQuery(() => ({
    queryKey: ["claxedo", "remote-access", "provider-config", input.serverUrl] as const,
    queryFn: async () => await port()?.providerConfig?.rows() ?? [],
    enabled: status.data?.hostedSignedIn === true && port()?.providerConfig !== undefined,
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
  /**
   * Whether the account layer has a usable credential right now.
   *
   * Deliberately not `status.hostedSignedIn`. That is the connector's own
   * view — "an account client is configured" — and at boot it goes true before
   * the account session has finished restoring. Auto-resume believed it, called
   * start(), and the connector child's first account operation came back "not
   * signed in", which surfaced as `child-start: Error: connector closed` about
   * half a minute into launch. The account port is the layer that actually
   * holds the credential (main, on the desktop), so it is the only honest
   * answer to "could a signed operation succeed now".
   */
  const accountSigned = createMemo(() => account.state().status === "signed")

  async function enable() {
    const remote = port()
    if (!remote) throw new Error("This build cannot publish a machine for remote access")
    await remote.enable({ startAtLogin: startAtLogin() ?? false })
    input.onMachineChanged?.()
    await Promise.all([status.refetch(), devices.refetch()])
  }

  // Dispatch only: the rule itself is `remoteAccessResumeDecision`, so the
  // boot-order behaviour can be exercised without standing up a shell.
  let attempted = false
  createEffect(() => {
    const decision = remoteAccessResumeDecision({
      accountSigned: accountSigned(),
      desktop: platform.platform === "desktop",
      startAtLogin: startAtLogin() === true,
      enabled: status.data?.enabled === true,
      attempted,
    })
    attempted = decision.attempted
    if (decision.resume) void resume()
  })

  async function resume() {
    try {
      await enable()
    } catch {
      // The resume can still race the connector's own restart (a revoke lands
      // elsewhere, the child bounces) and start() then reports "connector
      // closed". That is not a crash to surface as an unhandled rejection: the
      // panel keeps its explicit Enable button and the status refetch shows the
      // truth.
      void status.refetch()
    }
  }

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
    /**
     * Whether the machine this client runs on is served by the desktop app.
     *
     * Read from the product rather than from an enrollment: it decides whether
     * `claxedo connect` is offered for THIS machine, and connect refuses to
     * start beside a live desktop daemon whatever the control plane holds.
     */
    servedByDesktopApp: () => platform.platform === "desktop",
    /** Absent where the product cannot rename, so the surface can omit the control. */
    canRename: () => port()?.rename !== undefined,
    /**
     * The machine this client runs on, where the product can name it.
     *
     * On the desktop this is the only row the Machines list has: `devices` is
     * absent there, so without it the panel would be empty on the very
     * computer the user is sitting at. Absent on a product whose `devices`
     * already lists this machine.
     */
    thisMachine: () => {
      const machine = status.data?.machine
      if (!machine) return undefined
      return { ...machine, workspaceIds: status.data?.sharedWorkspaceIds ?? [] }
    },
    async rename(hostId: string, displayName: string) {
      const remote = port()
      if (!remote?.rename) throw new Error("This build cannot rename a machine")
      await remote.rename({ hostId, displayName })
      await Promise.all([status.refetch(), devices.refetch()])
    },
    /**
     * Provider configuration per enrolled machine, or undefined where this
     * product cannot list enrollments. The providers a push carries go
     * straight to the port; the query holds only each machine's revisions.
     */
    providerConfig: (): RemoteAccessProviderConfig | undefined => {
      const remote = port()?.providerConfig
      if (!remote) return undefined
      return {
        rows: providerConfig.data ?? [],
        async onPush(enrollmentId, providers) {
          await remote.push({ enrollmentId, providers })
          await providerConfig.refetch()
        },
        async onClear(enrollmentId) {
          await remote.push({ enrollmentId, providers: {} })
          await providerConfig.refetch()
        },
      }
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
