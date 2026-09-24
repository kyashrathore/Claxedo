import "./terminal-pane.css"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { machine } from "@/lib/machine"
import { useServer } from "@/server"
import type { PaneProps } from "@/shell"
import type { TerminalBackend } from "../backend/types"
import { useTerminalRuntime } from "../context"
import { dictionary } from "../i18n"
import {
  transitionConnection,
  type TerminalConnection,
  type TerminalConnectionEvent,
  type TerminalPaneState,
} from "../model"
import { AccessoryRow } from "./accessory-row"
import { AgentBadge } from "./agent-badge"
import { mountTerminal, type TerminalMount } from "./terminal-mount"
import { TerminalStatus } from "./terminal-status"

export function TerminalPane(props: PaneProps<TerminalPaneState>): JSX.Element {
  const server = useServer()
  const terminals = useTerminalRuntime()
  const t = useTranslator(dictionary)
  const { placementId, terminalId } = props.state
  const store = terminals.store(placementId)
  onCleanup(terminals.retain(placementId))
  const row = createMemo(() => store.row(terminalId))
  const connection = machine<TerminalConnection, TerminalConnectionEvent>({ kind: "connecting" }, transitionConnection)
  const [backend, setBackend] = createSignal<TerminalBackend>()
  const [focused, setFocused] = createSignal(false)
  const overlay = () => connection.state().kind !== "attached"
  let host!: HTMLDivElement
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
    })
  })
  onCleanup(() => mount?.dispose())

  createEffect(() => {
    if (connection.state().kind === "ended") store.drop(terminalId)
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
      <div class="relative min-h-0 flex-1">
        <div
          ref={host}
          data-testid="terminal-host"
          tabIndex={-1}
          class="h-full w-full overflow-hidden select-text font-terminal"
          classList={{ invisible: overlay() }}
          onPointerDown={() => backend()?.focus()}
        />
        <div class="pointer-events-none absolute top-1.5 right-3">
          <AgentBadge status={row()?.agentStatus} />
        </div>
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
