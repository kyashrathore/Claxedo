import { Button } from "@opencode-ai/ui/button"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { REMOTE_ACCESS_PHONE_COPY, type RemoteAccessAvailability } from "./remote-access-state"

export type RemoteAccessDevice = {
  hostId: string
  displayName: string
  lastSeenAt: number
  workspaceIds: readonly string[]
}

/** One local workspace the user could publish for remote access. */
export type ShareableWorkspace = {
  workspaceId: string
  /** Display only — never used to address the workspace. */
  path: string
  label: string
  shared: boolean
}

export type RemoteAccessSurfaceProps = {
  availability: RemoteAccessAvailability
  devices: readonly RemoteAccessDevice[]
  showDevices?: boolean
  startAtLogin: boolean
  onStartAtLoginChange: (enabled: boolean) => void
  onEnable: () => void
  onSignIn: () => void
  onRevoke: (hostId: string) => void
  /**
   * The share flow. Absent in surfaces that only enroll the machine (the
   * onboarding empty state); Settings supplies all three.
   */
  shareableWorkspaces?: readonly ShareableWorkspace[]
  onShare?: (workspaceIds: readonly string[]) => Promise<void>
  shareLinkFor?: (workspaceId: string) => string
}

/**
 * The one place sharing lives: pick workspaces, share, scan.
 *
 * The flow reads top to bottom in the order the user acts: the machine's
 * status, then which workspaces to publish, then — only once something IS
 * shared — the QR and link a phone needs, then proof it connected. Sharing
 * used to hide in each workspace row's overflow menu with a toast as its only
 * trace; the row menus now carry no share action at all.
 */
export const RemoteAccessSurface: Component<RemoteAccessSurfaceProps> = (props) => {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [sharing, setSharing] = createSignal(false)
  const [shareError, setShareError] = createSignal<string>()
  const shareable = createMemo(() => props.shareableWorkspaces ?? [])
  const sharedWorkspaces = createMemo(() => shareable().filter((workspace) => workspace.shared))
  const pending = createMemo(() => [...selected()].filter((id) => shareable().some((w) => w.workspaceId === id && !w.shared)))

  // The QR belongs to one workspace at a time. The user's pick wins while it
  // is still shared; otherwise the newest share is shown — derived, so there
  // is no effect to fall out of sync.
  const [chosenQrWorkspaceId, setQrWorkspaceId] = createSignal<string>()
  const qrWorkspaceId = createMemo(() => {
    const shared = sharedWorkspaces()
    const chosen = chosenQrWorkspaceId()
    if (chosen && shared.some((workspace) => workspace.workspaceId === chosen)) return chosen
    return shared.at(-1)?.workspaceId
  })
  const qrLink = createMemo(() => {
    const id = qrWorkspaceId()
    return id && props.shareLinkFor ? props.shareLinkFor(id) : undefined
  })
  const [qr] = createResource(qrLink, async (link) => {
    const { default: QRCode } = await import("qrcode")
    return QRCode.toDataURL(link, { width: 224, margin: 1 })
  })

  const toggle = (workspaceId: string) => {
    const next = new Set(selected())
    if (next.has(workspaceId)) next.delete(workspaceId)
    else next.add(workspaceId)
    setSelected(next)
  }

  const share = async () => {
    const ids = pending()
    if (ids.length === 0 || sharing() || !props.onShare) return
    setSharing(true)
    setShareError(undefined)
    try {
      await props.onShare(ids)
      setSelected(new Set<string>())
    } catch (error) {
      setShareError(error instanceof Error ? error.message : String(error))
    } finally {
      setSharing(false)
    }
  }

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
          <Button class="mt-3" onClick={props.onSignIn}>Sign in</Button>
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
          <Button class="mt-3" onClick={props.onEnable}>Enable remote access</Button>
        </div>
      </Show>

      <Show when={props.availability.state === "enabled" ? props.availability : undefined}>
        {(availability) => (
          <div class="flex flex-col gap-4">
            {/* 1 · This machine is reachable. */}
            <div class="flex items-center gap-2 rounded-md border border-border-weak-base bg-surface-raised-base px-4 py-3">
              <span class="size-2 shrink-0 rounded-full bg-icon-success-base" aria-hidden="true" />
              <span class="text-13-medium text-text-strong">Remote access is on</span>
              <span class="text-12-regular text-text-weak">
                This machine keeps one encrypted relay connection for everything it shares.
              </span>
            </div>

            {/* 2 · Choose what a phone may reach. */}
            <Show when={props.shareableWorkspaces}>
              <div class="rounded-md border border-border-weak-base p-4">
                <h3 class="text-14-medium text-text-strong">Share workspaces</h3>
                <p class="mt-1 text-12-regular text-text-weak">
                  Pick the local workspaces to publish, then share. Shared workspaces stay shared until this
                  machine is revoked below.
                </p>
                <Show
                  when={shareable().length > 0}
                  fallback={<p class="mt-3 text-12-regular text-text-weaker">Open a project to have something to share.</p>}
                >
                  <ul class="mt-3 flex flex-col gap-1">
                    <For each={shareable()}>
                      {(workspace) => (
                        <li>
                          <label
                            class="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-base-hover"
                            classList={{ "cursor-default": workspace.shared }}
                          >
                            <input
                              type="checkbox"
                              checked={workspace.shared || selected().has(workspace.workspaceId)}
                              disabled={workspace.shared}
                              onChange={() => toggle(workspace.workspaceId)}
                            />
                            <span class="truncate text-13-medium text-text-base">{workspace.label}</span>
                            <span class="min-w-0 flex-1 truncate text-11-regular text-text-weaker">{workspace.path}</span>
                            <Show when={workspace.shared}>
                              <span class="shrink-0 text-11-regular text-icon-success-base">Shared</span>
                            </Show>
                          </label>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div class="mt-3 flex items-center gap-3">
                    <Button disabled={pending().length === 0 || sharing()} onClick={() => void share()}>
                      {sharing()
                        ? "Sharing…"
                        : pending().length > 1
                          ? `Share ${pending().length} workspaces`
                          : "Share"}
                    </Button>
                    <Show when={shareError()}>
                      {(message) => <span class="text-12-regular text-icon-critical-base">{message()}</span>}
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            {/* 3 · The way in, only once something is shared. */}
            <Show when={sharedWorkspaces().length > 0}>
              <div class="grid grid-cols-1 gap-4 rounded-md border border-border-weak-base p-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
                <div class="flex min-h-56 items-center justify-center rounded-md bg-surface-base p-2">
                  <Show when={qr()} fallback={<span class="text-12-regular text-text-weaker">Preparing QR code…</span>}>
                    {(source) => <img class="size-52 max-w-full" src={source()} alt="Remote workspace QR code" />}
                  </Show>
                </div>
                <div class="flex min-w-0 flex-col justify-center gap-3">
                  <div>
                    <h3 class="text-14-medium text-text-strong">Open on your phone</h3>
                    <p class="mt-1 text-12-regular text-text-weak">{REMOTE_ACCESS_PHONE_COPY}</p>
                  </div>
                  <Show when={sharedWorkspaces().length > 1}>
                    <div class="flex flex-wrap gap-1">
                      <For each={sharedWorkspaces()}>
                        {(workspace) => (
                          <button
                            type="button"
                            class="rounded border border-border-weak-base px-2 py-0.5 text-11-regular transition-colors"
                            classList={{
                              "bg-surface-base-active text-text-strong": qrWorkspaceId() === workspace.workspaceId,
                              "text-text-weak hover:text-text-base": qrWorkspaceId() !== workspace.workspaceId,
                            }}
                            onClick={() => setQrWorkspaceId(workspace.workspaceId)}
                          >
                            {workspace.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={availability().proven}>
                    <p class="text-12-medium text-icon-success-base">Opened on a second device</p>
                  </Show>
                  <Show when={qrLink()}>
                    {(link) => (
                      <div class="flex min-w-0 items-center gap-2">
                        <code class="min-w-0 flex-1 truncate rounded bg-surface-raised-base px-2 py-1 text-11-regular">{link()}</code>
                        <Button size="small" variant="secondary" onClick={() => void navigator.clipboard.writeText(link())}>Copy link</Button>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
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
    <h3 id="remote-access-devices-title" class="text-14-medium text-text-strong">Enrolled machines</h3>
    <p class="text-12-regular text-text-weak">
      Each machine below serves its shared workspaces over the relay. Revoking a machine ends its remote
      access and unshares everything it published.
    </p>
    <Show when={props.devices.length > 0} fallback={<p class="text-12-regular text-text-weak">No enrolled machines.</p>}>
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
    </Show>
  </section>
)
