import { terminalFontFamily, usePreferences } from "@/settings"
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { machine } from "@/lib/machine"
import { useServer } from "@/server"
import { showToast } from "@/ui"
import type { PaneProps } from "@/shell"
import type { TerminalBackend } from "../backend/types"
import { useTerminalRuntime } from "../context"
import { terminalDictionary } from "../i18n"
import {
  transitionConnection,
  type TerminalConnection,
  type TerminalConnectionEvent,
  type TerminalPaneState,
} from "../model"
import { AccessoryRow } from "./accessory-row"
import { mountTerminal, type TerminalMount } from "./terminal-mount"
import { TerminalStatus, useConnectionToasts } from "./terminal-status"

export function TerminalPane(props: PaneProps<TerminalPaneState>): JSX.Element {
  const server = useServer()
  const terminals = useTerminalRuntime()
  const t = useTranslator(terminalDictionary)
  const { placementId, terminalId } = props.state
  const preferences = usePreferences()
  const store = terminals.store(placementId)
  onCleanup(terminals.retain(placementId))
  const row = createMemo(() => store.row(terminalId))
  const connection = machine<TerminalConnection, TerminalConnectionEvent>({ kind: "connecting" }, transitionConnection)
  const [backend, setBackend] = createSignal<TerminalBackend>()
  const [focused, setFocused] = createSignal(false)
  const [attachedOnce, setAttachedOnce] = createSignal(false)
  const overlay = () => {
    const current = connection.state()
    if (current.kind === "failed") return current.failure === "start"
    return !attachedOnce() && current.kind === "connecting"
  }
  let host!: HTMLDivElement
  const recoverTerminal = () =>
    store.recover(terminalId).then(
      (terminal) => terminals.open({ placementId, terminalId: terminal.id }, props.paneId),
      (error: unknown) => {
        console.warn("The lost terminal could not be recreated", { terminalId, error })
        showToast({ variant: "error", title: t("terminal.connectionLost.title"), description: t("terminal.connectionLost.description") })
      },
    )
  let mount: TerminalMount | undefined

  onMount(() => {
    store.loadAgentStatus(terminalId).catch((error: unknown) => {
      console.error("Terminal agent status failed to load", { terminalId, error })
    })
    mount = mountTerminal({
      host,
      server,
      placementId,
      terminalId,
      row,
      connection,
      renderers: terminals.renderers,
      openFile: terminals.openFile,
      onBackend: setBackend,
      terminalFont: () => (preferences.appearance.terminalFont.trim() ? terminalFontFamily(preferences.appearance.terminalFont) : undefined),
      screenReaderMode: () => preferences.appearance.terminalScreenReader,
    })
  })
  onCleanup(() => mount?.dispose())

  useConnectionToasts(connection.state)
  createEffect(
    on(
      () => connection.state().kind,
      (kind) => {
        if (kind === "attached") setAttachedOnce(true)
        if (kind === "ended") store.drop(terminalId)
        if (kind === "gone") void recoverTerminal()
      },
    ),
  )

  createEffect(() => {
    const current = row()
    const busy = current?.agentStatus === "working" || current?.agentStatus === "waitingOnUser"
    if (props.active && current?.seen && !busy) store.clearSeen(terminalId)
  })

  return (
    <section
      aria-label={t("terminal.pane")}
      data-testid="terminal-pane"
      data-terminal-id={terminalId}
      data-terminal-connection={connection.state().kind}
      data-terminal-connected={connection.state().kind === "attached" ? "true" : "false"}
      class="flex h-full w-full min-h-0 flex-col bg-background-base"
      onFocusIn={() => setFocused(true)}
      onFocusOut={() => setFocused(false)}
    >
      <div class="relative min-h-0 flex-1 pl-3 pt-1">
        <div
          ref={host}
          data-testid="terminal-host"
          tabIndex={-1}
          class="h-full w-full overflow-hidden select-text font-terminal"
          classList={{ invisible: overlay() }}
          onPointerDown={() => backend()?.focus()}
        />
        <Show when={overlay()}>
          <div class="absolute inset-0 bg-background-base">
            <TerminalStatus
              connection={connection.state()}
              onRetry={() => mount?.retry()}
            />
          </div>
        </Show>
      </div>
      <AccessoryRow active={focused} onKey={(data) => mount?.send(data)} />
    </section>
  )
}
