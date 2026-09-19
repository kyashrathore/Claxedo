import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Show, createResource, createSignal, type Component } from "solid-js"
import type {
  MachineProviderBinding,
  MachineProviderConfigRow,
} from "@/platform/remote-access/machine-remote-access-port"
import { MachineProviderConfig } from "./machine-provider-config"
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

/**
 * Provider configuration per enrolled machine, keyed by host id against
 * `devices`. Absent where the product cannot list enrollments, so a machine
 * row shows no control rather than one that cannot name its target.
 */
export type RemoteAccessProviderConfig = {
  rows: readonly MachineProviderConfigRow[]
  onPush: (enrollmentId: string, providers: Record<string, MachineProviderBinding>) => Promise<void>
  onClear: (enrollmentId: string) => Promise<void>
}

/**
 * The machine this app is running on, where the product can name it.
 *
 * Never listed alongside `devices`: a product that enumerates the account's
 * fleet already has this machine in it, and one that does not (the desktop,
 * which knows only itself) has no fleet to list. So this row and that list are
 * the two halves of the same section, never two views of one machine.
 */
export type RemoteAccessThisMachine = {
  displayName: string
  online: boolean
  workspaceIds: readonly string[]
}

export type RemoteAccessSurfaceProps = {
  availability: RemoteAccessAvailability
  /** Whose machine this is. Absent in surfaces that only enroll it. */
  identity?: RemoteAccessIdentity
  devices: readonly RemoteAccessDevice[]
  /** Absent where the product cannot name the machine it runs on. */
  thisMachine?: RemoteAccessThisMachine
  showDevices?: boolean
  startAtLogin: boolean
  onStartAtLoginChange: (enabled: boolean) => void
  onEnable: () => void | Promise<void>
  onSignIn: () => void
  onRevoke: (hostId: string) => void
  /** Offered only where the product can genuinely pause its own heartbeat. */
  onPause?: () => void | Promise<void>
  /**
   * Rename a machine. Absent where the product cannot write the name, which is
   * a different thing from a machine whose name may not change.
   */
  onRename?: (hostId: string, displayName: string) => void | Promise<void>
  providerConfig?: RemoteAccessProviderConfig
  /**
   * Whether the machine this surface runs on is served by the desktop app.
   *
   * It decides whether `claxedo connect` is offered for THIS machine: the
   * desktop already serves it under its own enrollment and `connect` refuses to
   * start beside a running desktop.
   */
  servedByDesktopApp?: boolean
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
          <p class="mt-1 text-12-regular text-text-weak" data-slot="remote-access-disclosure">
            {REMOTE_ACCESS_PUBLICATION_DISCLOSURE}
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

      <Show when={props.showDevices !== false}>
        <Show when={props.devices.length > 0 || props.thisMachine !== undefined}>
          <RemoteAccessDevices
            devices={props.devices}
            {...(props.thisMachine ? { thisMachine: props.thisMachine } : {})}
            onRevoke={props.onRevoke}
            {...(props.onRename ? { onRename: props.onRename } : {})}
            {...(props.providerConfig ? { providerConfig: props.providerConfig } : {})}
          />
        </Show>
        <AddMachine servedByDesktopApp={props.servedByDesktopApp === true} />
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

/**
 * What turning the switch on sends, stated on the switch.
 *
 * Publication is machine-level and carries the inventory itself, not just a
 * reachability flag, so the consequence is named where the decision is taken
 * rather than in a help page nobody opens.
 */
export const REMOTE_ACCESS_PUBLICATION_DISCLOSURE =
  "Your workspace names and paths are sent to the control plane so your other devices can find them."

/** Mints the single-use token, on a machine that is already signed in. */
const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
/** Run on the machine being added, with the token the invite printed. */
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

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

/**
 * One instruction per machine, and the `claxedo connect` one for the machine
 * the user is NOT sitting at.
 *
 * A machine running the desktop app is already served under its own
 * enrollment, and `connect` refuses to start beside a live desktop daemon, so
 * offering the command there would be offering a command that fails.
 */
const AddMachine: Component<{ servedByDesktopApp: boolean }> = (props) => (
  <section class="flex flex-col gap-2" aria-labelledby="add-machine-title">
    <h3 id="add-machine-title" class="text-14-medium text-text-strong">Add a machine</h3>
    <div class="rounded-md border border-border-weak-base p-3">
      <h4 class="text-13-medium text-text-strong">The computer you are sitting at</h4>
      <Show
        when={props.servedByDesktopApp}
        fallback={
          <p class="mt-1 text-12-regular text-text-weak">
            Install the Claxedo desktop app on it and sign in. It appears here under its own name.
          </p>
        }
      >
        <p class="mt-1 text-12-regular text-text-weak" data-slot="this-machine-already-added">
          The desktop app already serves this machine under its own name. Nothing to install.
        </p>
      </Show>
    </div>
    <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3" data-slot="add-connect-host">
      <div>
        <h4 class="text-13-medium text-text-strong">Another machine you own</h4>
        <p class="mt-1 text-12-regular text-text-weak">
          Run <code>claxedo host invite</code> on this machine for a single-use token, then run{" "}
          <code>claxedo connect</code> on the machine you are adding.
        </p>
      </div>
      <CopyableCommand command={INVITE_COMMAND} label="Copy invite command" />
      <CopyableCommand command={CONNECT_COMMAND} label="Copy connect command" />
    </div>
  </section>
)

const CopyableCommand: Component<{ command: string; label: string }> = (props) => (
  <div class="flex min-w-0 items-center gap-2">
    <code class="min-w-0 flex-1 truncate rounded bg-surface-base px-2 py-1 text-11-regular">{props.command}</code>
    <Button
      size="small"
      variant="secondary"
      aria-label={props.label}
      onClick={() => void navigator.clipboard.writeText(props.command)}
    >
      Copy
    </Button>
  </div>
)

export const RemoteAccessDevices: Component<{
  devices: readonly RemoteAccessDevice[]
  thisMachine?: RemoteAccessThisMachine
  onRevoke: (hostId: string) => void
  onRename?: (hostId: string, displayName: string) => void | Promise<void>
  providerConfig?: RemoteAccessProviderConfig
}> = (props) => (
  <section class="flex flex-col gap-2" aria-labelledby="remote-access-devices-title">
    <h3 id="remote-access-devices-title" class="text-14-medium text-text-strong">Machines</h3>
    <p class="text-12-regular text-text-weak">
      Each machine below serves the workspaces it holds. Revoking a machine ends its remote access.
    </p>
    <Show when={props.thisMachine}>
      {(here) => (
        <MachineRow
          device={{
            hostId: THIS_MACHINE,
            displayName: here().displayName,
            online: here().online,
            workspaceIds: here().workspaceIds,
          }}
          here
          onRevoke={props.onRevoke}
          {...(props.onRename ? { onRename: props.onRename } : {})}
        />
      )}
    </Show>
    <For each={props.devices}>
      {(device) => (
        <div class="flex flex-col gap-2">
          <MachineRow
            device={device}
            onRevoke={props.onRevoke}
            {...(props.onRename ? { onRename: props.onRename } : {})}
          />
          <Show when={props.providerConfig}>
            {(config) => (
              <Show when={config().rows.find((row) => row.hostId === device.hostId)}>
                {(row) => (
                  <MachineProviderConfig
                    machineName={device.displayName}
                    row={row()}
                    onPush={config().onPush}
                    onClear={config().onClear}
                  />
                )}
              </Show>
            )}
          </Show>
        </div>
      )}
    </For>
  </section>
)

/**
 * One machine, under the name it derived for itself, and the owner's override
 * of that name.
 *
 * The draft is seeded from the device on every open rather than held across
 * renames, so a rename that lands from another device is what the next open
 * shows.
 */
const MachineRow: Component<{
  device: { hostId: string; displayName: string; lastSeenAt?: number; online?: boolean; workspaceIds: readonly string[] }
  /** The computer the user is sitting at, whose revoke the panel above already offers. */
  here?: boolean
  onRevoke: (hostId: string) => void
  onRename?: (hostId: string, displayName: string) => void | Promise<void>
}> = (props) => {
  const [draft, setDraft] = createSignal<string>()
  const commit = () => {
    const name = draft()?.trim()
    setDraft(undefined)
    if (!name || name === props.device.displayName) return
    void props.onRename?.(props.device.hostId, name)
  }
  return (
    <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
      <div class="min-w-0 flex-1">
        <Show
          when={draft() !== undefined}
          fallback={<div class="truncate text-13-medium text-text-strong">{props.device.displayName}</div>}
        >
          <input
            class="w-full rounded bg-surface-base px-2 py-1 text-13-medium text-text-strong"
            aria-label={`Name for ${props.device.displayName}`}
            value={draft() ?? ""}
            autofocus
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit()
              if (event.key === "Escape") setDraft(undefined)
            }}
          />
        </Show>
        <div class="text-11-regular text-text-weak" data-slot="machine-state">
          {props.here
            ? `This computer · ${props.device.online ? "Remote access on" : "Remote access off"}`
            : `Last seen ${new Date(props.device.lastSeenAt ?? 0).toLocaleString()}`}{" "}
          · {props.device.workspaceIds.length}{" "}
          {props.device.workspaceIds.length === 1 ? "workspace" : "workspaces"}
        </div>
      </div>
      <Show when={props.onRename}>
        <Button
          size="small"
          variant="secondary"
          aria-label={`Rename ${props.device.displayName}`}
          onClick={() => setDraft(props.device.displayName)}
        >
          Rename
        </Button>
      </Show>
      <Show when={!props.here}>
        <Button size="small" variant="secondary" onClick={() => props.onRevoke(props.device.hostId)}>
          Revoke {props.device.displayName}
        </Button>
      </Show>
    </div>
  )
}
