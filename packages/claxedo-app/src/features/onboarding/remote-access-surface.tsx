import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Show, createResource, createSignal, type Component } from "solid-js"
import {
  REMOTE_ACCESS_PHONE_COPY,
  type RemoteAccessAvailability,
  type RemoteAccessIdentity,
} from "./remote-access-state"

export type RemoteAccessDevice = {
  hostId: string
  displayName: string
  lastSeenAt: number
  workspaceIds: readonly string[]
}

export type RemoteAccessSurfaceProps = {
  availability: RemoteAccessAvailability
  /** Whose machine this is. Absent in surfaces that only enroll it. */
  identity?: RemoteAccessIdentity
  devices: readonly RemoteAccessDevice[]
  showDevices?: boolean
  startAtLogin: boolean
  onStartAtLoginChange: (enabled: boolean) => void
  onEnable: () => void | Promise<void>
  onSignIn: () => void
  onRevoke: (hostId: string) => void
  /** Offered only where the product can genuinely pause its own heartbeat. */
  onPause?: () => void | Promise<void>
  /**
   * How many workspaces this machine serves right now, straight off the
   * connector snapshot. Undefined while that is still unknown — which is a
   * different thing from zero, and shows as a grey light rather than "0".
   */
  serving?: number
  /**
   * Why serving is not fully up yet, in the user's terms. Undefined is the
   * ONLY state that earns a green light.
   */
  servingPending?: string
  /** The address a second device opens. Known synchronously — no round trip. */
  deviceLink?: string
  /** One workspace the machine could not publish on its last pass. */
  shareFailure?: { label: string; message: string }
}

/**
 * Remote access, at MACHINE level.
 *
 * Enabling it publishes every local workspace on this machine, and every one
 * opened afterwards. So there is nothing here to tick: the panel states one
 * machine's status, offers one way to reach it, and offers the two ways to
 * stop it. The tick list this replaced asked the user to re-answer, per
 * workspace, a question they had already answered once by turning the feature
 * on — and every workspace they later opened silently defaulted to "no".
 *
 * The live dot is deliberately hard to turn green: it needs BOTH an enabled
 * machine and `servingPending === undefined`, which the caller only reports
 * once the published set equals the machine's local inventory. A dot that went
 * green on "enabled" alone would be green while the machine served nothing.
 */
export const RemoteAccessSurface: Component<RemoteAccessSurfaceProps> = (props) => {
  const [enableError, setEnableError] = createSignal<string>()
  const [enabling, setEnabling] = createSignal(false)
  const enable = () => {
    if (enabling()) return
    setEnabling(true)
    setEnableError(undefined)
    void Promise.resolve(props.onEnable())
      // Enabling reaches the control plane through the Host Connector; its
      // failure belongs on this panel, not in an unhandledrejection overlay.
      .catch((error) => setEnableError(error instanceof Error ? error.message : String(error)))
      .finally(() => setEnabling(false))
  }
  /**
   * Why the light is grey, or undefined for green.
   *
   * A caller that reports no serving count has not told this panel what the
   * machine serves, which is NOT the same as "it serves everything" — so the
   * light stays grey and says so. Only a caller that both counts the served
   * workspaces and reports nothing outstanding can turn it green.
   */
  const pending = () =>
    props.serving === undefined ? "Checking what this machine serves" : props.servingPending
  const [connectOpen, setConnectOpen] = createSignal(false)
  // Encoding starts as soon as the surface HAS the link — the link is a pure
  // function of a baked deployment origin, so there is nothing to fetch — and
  // the code is therefore already drawn by the time anyone opens the panel.
  const [qr] = createResource(() => props.deviceLink, async (link) => {
    const { default: QRCode } = await import("qrcode")
    return await QRCode.toDataURL(link, { width: 224, margin: 1 })
  })

  return (
    <div class="flex flex-col gap-4" data-component="remote-access-surface">
      <Show when={props.availability.state === "locked" ? props.availability : undefined}>
        {(availability) => (
          <div class="rounded-md border border-border-weak-base bg-surface-raised-base p-4">
            <h3 class="text-14-medium text-text-strong">Remote access is locked</h3>
            <p class="mt-1 text-12-regular text-text-weak">{availability().reason}</p>
          </div>
        )}
      </Show>

      <Show when={props.availability.state === "sign-in-required"}>
        <div class="rounded-md border border-border-weak-base p-4">
          <h3 class="text-14-medium text-text-strong">Sign in to continue</h3>
          <p class="mt-1 text-12-regular text-text-weak">Your hosted account authorizes this machine.</p>
          <Button class="mt-3" onClick={props.onSignIn}>Sign in</Button>
        </div>
      </Show>

      <Show when={props.availability.state === "ready-to-enable"}>
        <div class="rounded-md border border-border-weak-base p-4">
          <h3 class="text-14-medium text-text-strong">Enable remote access</h3>
          <p class="mt-1 text-12-regular text-text-weak">
            Reach every workspace on this machine from your other devices.
          </p>
          <label class="mt-3 flex items-center gap-2 text-12-regular text-text-base">
            <input
              type="checkbox"
              checked={props.startAtLogin}
              onChange={(event) => props.onStartAtLoginChange(event.currentTarget.checked)}
            />
            Start Claxedo when I sign in
          </label>
          <div class="mt-3 flex items-center gap-3">
            <Button disabled={enabling()} onClick={enable}>
              {enabling() ? "Enabling…" : "Enable remote access"}
            </Button>
            <Show when={enableError()}>
              {(message) => <span class="text-12-regular text-icon-critical-base">{message()}</span>}
            </Show>
          </div>
        </div>
      </Show>

      <Show when={props.availability.state === "enabled"}>
        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-4">
          <Show when={props.identity}>
            {(identity) => <RemoteAccessIdentityRow identity={identity()} />}
          </Show>

          <div class="flex items-center gap-2">
            <span
              class="size-2 shrink-0 rounded-full"
              classList={{
                "bg-icon-success-base": !pending(),
                "bg-icon-weak-base": !!pending(),
              }}
              aria-hidden="true"
            />
            <span
              class="text-13-medium text-text-strong"
              title={pending()}
              data-serving-state={pending() ? "pending" : "up"}
            >
              {servingLabel(props.serving)}
            </span>
            <Show when={pending()}>
              {(reason) => <span class="text-12-regular text-text-weak">{reason()}</span>}
            </Show>
          </div>

          <Show when={props.shareFailure}>
            {(failure) => (
              <p class="text-12-regular text-icon-critical-base">
                Couldn't share {failure().label} — retrying on next sync. {failure().message}
              </p>
            )}
          </Show>

          <Show when={props.availability.state === "enabled" && props.availability.proven}>
            <p class="text-12-medium text-icon-success-base">Opened on a second device</p>
          </Show>

          <div class="flex flex-wrap items-center gap-2">
            <Button size="small" disabled={!props.deviceLink} onClick={() => setConnectOpen(true)}>
              Connect a device
            </Button>
            <Show when={props.onPause}>
              <Button size="small" variant="secondary" onClick={() => void props.onPause?.()}>Pause</Button>
            </Show>
            <Button size="small" variant="secondary" onClick={() => props.onRevoke(THIS_MACHINE)}>
              Revoke this machine
            </Button>
          </div>
        </div>
      </Show>

      <Show when={connectOpen() && props.deviceLink ? props.deviceLink : undefined}>
        {(link) => (
          <ConnectDeviceModal link={link()} qr={qr()} onClose={() => setConnectOpen(false)} />
        )}
      </Show>

      <Show when={props.showDevices !== false && props.devices.length > 0}>
        <RemoteAccessDevices devices={props.devices} onRevoke={props.onRevoke} />
      </Show>
    </div>
  )
}

/**
 * The host id the panel's own Revoke carries.
 *
 * The panel is about the machine the user is sitting at, and every product
 * that binds this surface revokes exactly that one: the desktop's connector
 * can only destroy the key on this disk and ignores the argument entirely, and
 * the HTTP product's server publishes the machine it is itself running on.
 * Naming it is honest; inventing a per-device list to pick from is not.
 */
const THIS_MACHINE = "this-machine"

function servingLabel(serving: number | undefined) {
  if (serving === undefined) return "Serving this machine's workspaces"
  return serving === 1 ? "Serving 1 workspace" : `Serving ${serving} workspaces`
}

const RemoteAccessIdentityRow: Component<{ identity: RemoteAccessIdentity }> = (props) => (
  <div class="flex min-w-0 items-center gap-2">
    <Show
      when={props.identity.state === "named" ? props.identity : undefined}
      fallback={
        <Show
          when={props.identity.state === "pending"}
          fallback={<span class="text-12-regular text-text-weak">Not signed in</span>}
        >
          {/* Never a placeholder name here: a generic word where the account
              name belongs reads as a finished lookup. */}
          <Spinner class="size-3.5 shrink-0" aria-label="Loading account" />
          <span class="text-12-regular text-text-weak">Signing in…</span>
        </Show>
      }
    >
      {(identity) => (
        <span class="min-w-0 truncate text-12-regular text-text-weak" data-slot="remote-access-identity">
          {identity().label}
        </span>
      )}
    </Show>
  </div>
)

/** The way in. Presentational only — the code was encoded before this opened. */
const ConnectDeviceModal: Component<{
  link: string
  qr: string | undefined
  onClose: () => void
}> = (props) => {
  return (
    <div
      class="fixed inset-0 z-[240] flex items-center justify-center bg-background-base/70 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a device"
        class="flex w-full max-w-96 flex-col gap-3 rounded-md border border-border-weak-base bg-surface-raised-base p-4"
      >
        <div>
          <h3 class="text-14-medium text-text-strong">Connect a device</h3>
          <p class="mt-1 text-12-regular text-text-weak">{REMOTE_ACCESS_PHONE_COPY}</p>
        </div>
        <div class="flex min-h-56 items-center justify-center rounded-md bg-surface-base p-2">
          <Show
            when={props.qr}
            fallback={
              <span class="flex items-center gap-2 text-12-regular text-text-weaker">
                <Spinner class="size-3.5" />
                Preparing QR code…
              </span>
            }
          >
            {(source) => <img class="size-52 max-w-full" src={source()} alt="Remote access QR code" />}
          </Show>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded bg-surface-base px-2 py-1 text-11-regular">{props.link}</code>
          <Button size="small" variant="secondary" onClick={() => void navigator.clipboard.writeText(props.link)}>
            Copy link
          </Button>
        </div>
        <div class="flex justify-end">
          <Button size="small" variant="secondary" onClick={() => props.onClose()}>Close</Button>
        </div>
      </div>
    </div>
  )
}

export const RemoteAccessDevices: Component<{
  devices: readonly RemoteAccessDevice[]
  onRevoke: (hostId: string) => void
}> = (props) => (
  <section class="flex flex-col gap-2" aria-labelledby="remote-access-devices-title">
    <h3 id="remote-access-devices-title" class="text-14-medium text-text-strong">Enrolled machines</h3>
    <p class="text-12-regular text-text-weak">
      Each machine below serves every local workspace it holds. Revoking a machine ends its remote access.
    </p>
    <For each={props.devices}>
      {(device) => (
        <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-strong">{device.displayName}</div>
            <div class="text-11-regular text-text-weak">
              Last seen {new Date(device.lastSeenAt).toLocaleString()} · {device.workspaceIds.length} shared{" "}
              {device.workspaceIds.length === 1 ? "workspace" : "workspaces"}
            </div>
          </div>
          <Button size="small" variant="secondary" onClick={() => props.onRevoke(device.hostId)}>
            Revoke {device.displayName}
          </Button>
        </div>
      )}
    </For>
  </section>
)
