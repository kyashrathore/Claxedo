import { Button } from "@opencode-ai/ui/button"
import { useNavigate } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js"
import { resolveProductUiFlags } from "@/app/composition/product-ui-flags"
import { useServer } from "@/app/connection/server"
import { useConfigOptional } from "@/app/providers/config"
import { MachineProviderConfig } from "@/features/settings/remote-access/machine-provider-config"
import { useRemoteAccessController } from "@/features/settings/remote-access/remote-access-controller"
import {
  RemoteAccessSurface,
  THIS_MACHINE,
  type RemoteAccessDevice,
  type RemoteAccessProviderConfig,
  type RemoteAccessThisMachine,
} from "@/features/settings/remote-access/remote-access-surface"
import { SettingsList, SettingsRow } from "@/ui/controls/settings-list"
import { useLocalWorkspaceAutoShareStatus } from "@/features/workspaces/data/auto-share-local-workspaces"
import { invalidateSharedWorkspaces } from "@/features/workspaces/data/shared-workspaces"
import { formatRelativeTime } from "@/lib/relative-time"
import { heartbeatFresh } from "@/platform/remote-access/machine-heartbeat"
import { ClaxedoIconButton } from "@/ui/controls/claxedo-icon-button"

/** Mints the single-use token, on a machine that is already signed in. */
const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
/** Run on the machine being added, with the token the invite printed. */
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

/**
 * The machines this account can reach.
 *
 * Composed here rather than under `features/settings`: the panel joins the
 * remote-access surface to the workspaces domain's publication status, and a
 * feature may not reach another feature directly.
 */
export const SettingsMachines: Component = () => {
  const server = useServer()
  const navigate = useNavigate()
  const config = useConfigOptional()
  const productUi = createMemo(() => resolveProductUiFlags(config))
  const queryClient = useQueryClient()
  const remoteAccess = useRemoteAccessController({
    serverUrl: server.url,
    signInAvailable: () => productUi().accountSignIn,
    // Enabling/pausing/revoking changes what this machine publishes, and the
    // reconciler decides from that set. Without this the browser product —
    // whose port cannot push — would sit on a stale answer for 30s and publish
    // nothing after the user pressed Enable.
    onMachineChanged: () => invalidateSharedWorkspaces(queryClient),
  })
  // Machine-level sharing: while remote access is on, every workspace this
  // machine holds is published, and one opened later is published as soon as
  // the inventory reports it. The reconciler runs in the app shell for the
  // whole session — this panel only reports what it found, because a driver
  // that started when Settings opened would only keep the promise while
  // Settings was open.
  const autoShare = createMemo(useLocalWorkspaceAutoShareStatus)

  return (
    <div class="flex flex-col gap-8 pb-10" data-component="settings-machines">
      <MachinesSection title="Remote access">
        <RemoteAccessSurface
          availability={remoteAccess.availability()}
          identity={remoteAccess.identity()}
          serving={autoShare().serving}
          servingPending={autoShare().pending}
          shareFailure={autoShare().failure}
          deviceLink={remoteAccess.deviceLink()}
          startAtLogin={remoteAccess.startAtLogin()}
          onStartAtLoginChange={(enabled) => void remoteAccess.setStartAtLogin(enabled)}
          onEnable={() => void remoteAccess.enable()}
          onSignIn={() => navigate("/login")}
          onPause={remoteAccess.canPause() ? () => void remoteAccess.pause() : undefined}
          onRevoke={(hostId) => void remoteAccess.revoke(hostId)}
        />
      </MachinesSection>

      <MachinesList
        devices={remoteAccess.devices.data ?? []}
        thisMachine={remoteAccess.thisMachine()}
        servedByDesktopApp={remoteAccess.servedByDesktopApp()}
        onRevoke={(hostId) => void remoteAccess.revoke(hostId)}
        onRename={
          remoteAccess.canRename()
            ? (hostId, displayName) => void remoteAccess.rename(hostId, displayName)
            : undefined
        }
        providerConfig={remoteAccess.providerConfig()}
      />
    </div>
  )
}

/** A section of the panel: its name, what it is for, and its card. */
const MachinesSection: Component<{ title: string; description?: string; children: JSX.Element }> = (props) => (
  <section class="flex flex-col gap-2">
    <div class="flex flex-col gap-0.5">
      <h2 class="text-14-medium text-text-strong">{props.title}</h2>
      <Show when={props.description}>
        {(text) => <p class="text-12-regular text-text-weak">{text()}</p>}
      </Show>
    </div>
    {props.children}
  </section>
)

/**
 * Whether a machine is reachable right now, as a light and as a word.
 *
 * Both, because neither alone answers it: a colour is a convention the reader
 * has to already know, and a sentence buried in a second line is not what the
 * eye lands on when the question is "is that one up".
 */
const MachineState: Component<{ online: boolean; label: string }> = (props) => (
  <span class="flex items-center gap-1.5" data-component="machine-state" data-online={props.online ? "true" : "false"}>
    <span
      class="size-1.5 shrink-0 rounded-full"
      classList={{ "bg-icon-success-base": props.online, "bg-icon-weak-base": !props.online }}
      aria-hidden="true"
    />
    <span class="text-12-regular text-text-weak">{props.label}</span>
  </span>
)

export const MachinesList: Component<{
  devices: readonly RemoteAccessDevice[]
  thisMachine?: RemoteAccessThisMachine
  servedByDesktopApp?: boolean
  onRevoke: (hostId: string) => void
  onRename?: (hostId: string, displayName: string) => void | Promise<void>
  providerConfig?: RemoteAccessProviderConfig
}> = (props) => (
  <MachinesSection
    title="Your machines"
    description="Each one serves the workspaces it holds. Revoking a machine ends its remote access."
  >
    <Show
      when={props.devices.length > 0 || props.thisMachine !== undefined}
      fallback={<AddMachine servedByDesktopApp={props.servedByDesktopApp} empty />}
    >
      <SettingsList>
        <Show when={props.thisMachine}>
          {(here) => (
            <MachineRow
              hostId={THIS_MACHINE}
              displayName={here().displayName}
              online={here().online}
              state={here().online ? "Connected · this computer" : "Not connected · this computer"}
              workspaces={here().workspaceIds.length}
              here
              onRevoke={props.onRevoke}
              {...(props.onRename ? { onRename: props.onRename } : {})}
            />
          )}
        </Show>
        <For each={props.devices}>
          {(device) => {
            const online = () => heartbeatFresh(device.lastSeenAt)
            return (
              <>
                <MachineRow
                  hostId={device.hostId}
                  displayName={device.displayName}
                  online={online()}
                  state={online() ? "Connected" : `Last seen ${formatRelativeTime(device.lastSeenAt)}`}
                  workspaces={device.workspaceIds.length}
                  onRevoke={props.onRevoke}
                  {...(props.onRename ? { onRename: props.onRename } : {})}
                />
                <Show when={props.providerConfig}>
                  {(config) => (
                    <Show when={config().rows.find((row) => row.hostId === device.hostId)}>
                      {(row) => (
                        <div class="pb-3">
                          <MachineProviderConfig
                            machineName={device.displayName}
                            row={row()}
                            onPush={config().onPush}
                            onClear={config().onClear}
                          />
                        </div>
                      )}
                    </Show>
                  )}
                </Show>
              </>
            )
          }}
        </For>
      </SettingsList>
      <AddMachine servedByDesktopApp={props.servedByDesktopApp} />
    </Show>
  </MachinesSection>
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
  hostId: string
  displayName: string
  online: boolean
  state: string
  workspaces: number
  /** The computer the user is sitting at, whose revoke the panel above already offers. */
  here?: boolean
  onRevoke: (hostId: string) => void
  onRename?: (hostId: string, displayName: string) => void | Promise<void>
}> = (props) => {
  const [draft, setDraft] = createSignal<string>()
  const commit = () => {
    const name = draft()?.trim()
    setDraft(undefined)
    if (!name || name === props.displayName) return
    void props.onRename?.(props.hostId, name)
  }
  return (
    <SettingsRow
      title={(
        <Show
          when={draft() !== undefined}
          fallback={<span class="block truncate">{props.displayName}</span>}
        >
          <input
            class="w-full rounded bg-surface-base px-2 py-1 text-14-medium text-text-strong"
            aria-label={`Name for ${props.displayName}`}
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
      )}
      description={(
        <span class="flex flex-wrap items-center gap-x-1.5" data-slot="machine-state">
          <MachineState online={props.online} label={props.state} />
          <span aria-hidden="true">·</span>
          <span>{props.workspaces === 1 ? "1 workspace" : `${props.workspaces} workspaces`}</span>
        </span>
      )}
    >
      <div class="flex items-center gap-1">
        <Show when={props.onRename}>
          <Button
            size="small"
            variant="ghost"
            aria-label={`Rename ${props.displayName}`}
            onClick={() => setDraft(props.displayName)}
          >
            Rename
          </Button>
        </Show>
        <Show when={!props.here}>
          <Button size="small" variant="ghost" onClick={() => props.onRevoke(props.hostId)}>
            Revoke {props.displayName}
          </Button>
        </Show>
      </div>
    </SettingsRow>
  )
}

/**
 * How a machine joins the account.
 *
 * Instructions, not a control: the only thing to press here copies a line of
 * shell, which is not a decision worth a button of its own. They stand open
 * when there is no machine yet — that is the whole of the empty state — and
 * fold away behind one line once the account has one.
 *
 * A machine running the desktop app is already served under its own
 * enrollment, and `connect` refuses to start beside a live desktop daemon, so
 * the first step tells that reader there is nothing to do.
 */
export const AddMachine: Component<{ servedByDesktopApp?: boolean; empty?: boolean }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const shown = () => props.empty === true || open()
  return (
    <div class="flex flex-col gap-2">
      <Show when={!props.empty}>
        <button
          type="button"
          class="self-start rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"
          data-action="add-machine"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen(!open())}
        >
          {open() ? "Hide instructions" : "Add another machine"}
        </button>
      </Show>
      <Show when={shown()}>
        <div class="flex flex-col gap-5 rounded-lg border border-dashed border-border-weak-base p-4" data-slot="add-connect-host">
          <Show when={props.empty}>
            <p class="text-12-regular text-text-weak" data-component="machines-empty">
              No machine is enrolled yet. One appears above as soon as it is beating.
            </p>
          </Show>
          <Step
            number="1"
            title="The computer you are sitting at"
            description={props.servedByDesktopApp
              ? "The desktop app already serves this machine under its own name. Nothing to install."
              : "Install the Claxedo desktop app on it and sign in. It appears above under its own name."}
          />
          <Step
            number="2"
            title="Another machine you own"
            description="Run the first command here for a single-use token, then the second on the machine you are adding."
            commands={[
              { command: INVITE_COMMAND, label: "Copy invite command" },
              { command: CONNECT_COMMAND, label: "Copy connect command" },
            ]}
          />
        </div>
      </Show>
    </div>
  )
}

/** One numbered instruction, and the lines it asks the reader to run. */
const Step: Component<{
  number: string
  title: string
  description: string
  commands?: ReadonlyArray<{ command: string; label: string }>
}> = (props) => (
  <div class="flex gap-3">
    <span class="w-4 shrink-0 text-13-regular text-text-weak tabular-nums">{props.number}.</span>
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <div class="flex flex-col gap-0.5">
        <span class="text-13-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <For each={props.commands ?? []}>
        {(entry) => <CommandLine command={entry.command} label={entry.label} />}
      </For>
    </div>
  </div>
)

const CommandLine: Component<{ command: string; label: string }> = (props) => {
  const [copied, setCopied] = createSignal(false)
  // A fill of its own: the codex theme rebinds `bg-surface-base` inside
  // Settings to the page colour, which would leave the line unboxed.
  return (
    <div class="flex min-w-0 items-center gap-2 rounded-md border border-border-weak-base bg-surface-raised-base px-2 py-1.5">
      <code class="min-w-0 flex-1 truncate text-11-regular text-text-base">{props.command}</code>
      <ClaxedoIconButton
        icon={copied() ? "check" : "copy"}
        size="small"
        variant="ghost"
        aria-label={props.label}
        onClick={() => {
          void navigator.clipboard.writeText(props.command)
          setCopied(true)
        }}
      />
    </div>
  )
}
