import { createAsyncState } from "@/lib/async-state"
import { Button } from "@opencode-ai/ui/button"
import { For, Show, type Component } from "solid-js"
import { REMOTE_ACCESS_PHONE_COPY, type RemoteAccessAvailability } from "./remote-access-state"

export type RemoteAccessDevice = {
  hostId: string
  displayName: string
  lastSeenAt: number
  workspaceIds: readonly string[]
}

export type RemoteAccessSurfaceProps = {
  availability: RemoteAccessAvailability
  workspaceLink?: string
  devices: readonly RemoteAccessDevice[]
  showDevices?: boolean
  startAtLogin: boolean
  onStartAtLoginChange: (enabled: boolean) => void
  onEnable: () => void
  onSignIn: () => void
  onRevoke: (hostId: string) => void
}

export const RemoteAccessSurface: Component<RemoteAccessSurfaceProps> = (props) => {
  const qr = createAsyncState(async () => {
    const source = (() => (props.availability.state === "enabled" ? props.workspaceLink : undefined))()
    if (!source) return undefined
    return (async (link) => {
      const { default: QRCode } = await import("qrcode")
      return QRCode.toDataURL(link, { width: 224, margin: 1 })
    })(source)
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
          <p class="mt-1 text-12-regular text-text-weak">Your hosted account authorizes each remote workspace.</p>
          <Button class="mt-3" onClick={props.onSignIn}>
            Sign in
          </Button>
        </div>
      </Show>

      <Show when={props.availability.state === "ready-to-enable"}>
        <div class="rounded-md border border-border-weak-base p-4">
          <h3 class="text-14-medium text-text-strong">Enable remote access</h3>
          <p class="mt-1 text-12-regular text-text-weak">
            Claxedo enrolls this machine and keeps one encrypted relay connection for all local projects.
          </p>
          <label class="mt-3 flex items-center gap-2 text-12-regular text-text-base">
            <input
              type="checkbox"
              checked={props.startAtLogin}
              onChange={(event) => props.onStartAtLoginChange(event.currentTarget.checked)}
            />
            Start Claxedo when I sign in
          </label>
          <Button class="mt-3" onClick={props.onEnable}>
            Enable remote access
          </Button>
        </div>
      </Show>

      <Show when={props.availability.state === "enabled" ? props.availability : undefined}>
        {(availability) => (
          <div class="grid grid-cols-1 gap-4 rounded-md border border-border-weak-base p-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <div class="flex min-h-56 items-center justify-center rounded-md bg-surface-base p-2">
              <Show
                when={qr.data()}
                fallback={<span class="text-12-regular text-text-weaker">Preparing QR code…</span>}
              >
                {(source) => <img class="size-52 max-w-full" src={source()} alt="Remote workspace QR code" />}
              </Show>
            </div>
            <div class="flex min-w-0 flex-col justify-center gap-3">
              <div>
                <h3 class="text-14-medium text-text-strong">Open this workspace on your phone</h3>
                <p class="mt-1 text-12-regular text-text-weak">{REMOTE_ACCESS_PHONE_COPY}</p>
              </div>
              <Show when={availability().proven}>
                <p class="text-12-medium text-icon-success-base">Opened on a second device</p>
              </Show>
              <Show when={props.workspaceLink}>
                {(link) => (
                  <div class="flex min-w-0 items-center gap-2">
                    <code class="min-w-0 flex-1 truncate rounded bg-surface-raised-base px-2 py-1 text-11-regular">
                      {link()}
                    </code>
                    <Button size="small" variant="secondary" onClick={() => void navigator.clipboard.writeText(link())}>
                      Copy link
                    </Button>
                  </div>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.showDevices !== false}>
        <RemoteAccessDevices devices={props.devices} onRevoke={props.onRevoke} />
      </Show>
    </div>
  )
}

export const RemoteAccessDevices: Component<{
  devices: readonly RemoteAccessDevice[]
  onRevoke: (hostId: string) => void
}> = (props) => (
  <section class="flex flex-col gap-2" aria-labelledby="remote-access-devices-title">
    <h3 id="remote-access-devices-title" class="text-14-medium text-text-strong">
      Devices
    </h3>
    <Show
      when={props.devices.length > 0}
      fallback={<p class="text-12-regular text-text-weak">No enrolled machines.</p>}
    >
      <For each={props.devices}>
        {(device) => (
          <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
            <div class="min-w-0">
              <div class="truncate text-13-medium text-text-strong">{device.displayName}</div>
              <div class="text-11-regular text-text-weak">
                Last seen {new Date(device.lastSeenAt).toLocaleString()} · {device.workspaceIds.length} local{" "}
                {device.workspaceIds.length === 1 ? "project" : "projects"}
              </div>
            </div>
            <Button size="small" variant="secondary" onClick={() => props.onRevoke(device.hostId)}>
              Revoke {device.displayName}
            </Button>
          </div>
        )}
      </For>
    </Show>
  </section>
)
