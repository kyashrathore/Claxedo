import "./terminal-pane.css"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useServer } from "@/server"
import { machine } from "@/lib/machine"
import type { PaneProps } from "@/shell/types"
import type { TerminalBackend } from "../backend/types"
import { transitionConnection, type TerminalConnection, type TerminalConnectionEvent } from "../model"
import { TERMINAL_PANE_KIND, terminalPaneState, type TerminalPaneState } from "../pane"
import { useTerminalContext } from "../store"
import { mountTerminal, type TerminalMount } from "./terminal-mount"
import { TerminalStatus } from "./terminal-status"
import { AgentBadge } from "./agent-badge"
import { AccessoryRow } from "./accessory-row"
import { t } from "../i18n"

export function TerminalPane(props: PaneProps<TerminalPaneState>) {
  const server = useServer()
  const context = useTerminalContext()
  const store = context.store(props.state.placementId)
  const row = createMemo(() => store.row(props.state.terminalId))
  const connection = machine<TerminalConnection, TerminalConnectionEvent>({ kind: "connecting" }, transitionConnection)
  const [backend, setBackend] = createSignal<TerminalBackend>()
  const [focused, setFocused] = createSignal(false)
  const missing = () => store.load().kind === "ready" && row() === undefined
  const overlay = () => missing() || connection.state().kind !== "attached"
  let host!: HTMLDivElement
  let mount: TerminalMount | undefined

  onMount(() => {
    void store.loadAgentStatus(props.state.terminalId)
    mount = mountTerminal({
      host,
      server,
      placementId: props.state.placementId,
      terminalId: props.state.terminalId,
      row,
      connection,
      renderers: context.renderers,
      openPane: context.openPane,
      onBackend: setBackend,
    })
  })
  onCleanup(() => mount?.dispose())

  const recreate = async () => {
    const terminal = await store.recreate(props.state.terminalId)
    context.openPane(
      TERMINAL_PANE_KIND,
      terminalPaneState({ placementId: props.state.placementId, terminalId: terminal.id }),
      { paneId: props.paneId },
    )
  }

  return (
    <section
      aria-label={t("terminal.pane")}
      data-testid="terminal-pane"
      data-terminal-id={props.state.terminalId}
      data-terminal-connection={connection.state().kind}
      class="flex h-full w-full min-h-0 flex-col bg-background-base"
      onFocusIn={() => setFocused(true)}
      onFocusOut={() => setFocused(false)}
    >
      <header class="flex h-7 shrink-0 items-center gap-2 border-b border-border-weak-base px-2 text-12-regular text-text-weak">
        <span class="min-w-0 flex-1 truncate">{row()?.title ?? t("terminal.title")}</span>
        <AgentBadge status={row()?.agentStatus} />
      </header>
      <div class="relative min-h-0 flex-1">
        <div
          ref={host}
          data-testid="terminal-host"
          tabIndex={-1}
          class="h-full w-full overflow-hidden select-text font-mono"
          classList={{ invisible: overlay() }}
          onPointerDown={() => backend()?.focus()}
        />
        <Show when={overlay()}>
          <div class="absolute inset-0 bg-background-base">
            <TerminalStatus connection={connection.state()} missing={missing()} onRetry={() => mount?.retry()} onRecreate={() => void recreate()} />
          </div>
        </Show>
      </div>
      <AccessoryRow active={focused} onKey={(data) => backend()?.write("", () => {})} />
    </section>
  )
}
