import { createEffect, createMemo, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PlacementId, TerminalAgentStatus } from "@/server"
import { useTerminals, type TerminalItem } from "@/terminal"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createHoverEngagement } from "../hover-engagement"
import { railDictionary } from "../i18n"
import type { NavigationStatus } from "../model"
import { NavigationRow, NavigationRowGlyph, NavigationStatusMark } from "./navigation-row"
import { ClaxedoIcon as Icon, ClaxedoIconV2 } from "@/ui"

const AGENT_STATUS: Readonly<Record<TerminalAgentStatus, NavigationStatus>> = {
  working: "working",
  waitingOnUser: "permission",
  failed: "error",
  idle: "idle",
}

const TITLE_SUFFIX = { working: "rail.terminal.working", permission: "rail.terminal.needsInput", error: "rail.terminal.failed" } as const

export function TerminalRow(props: { readonly row: TerminalItem; readonly active: boolean; readonly prepareDrag?: () => string | undefined }): JSX.Element {
  const t = useTranslator(railDictionary)
  const terminals = useTerminals()
  const engagement = createHoverEngagement()
  const status = () => (props.row.agentStatus ? AGENT_STATUS[props.row.agentStatus] : "idle")
  const title = () => {
    const current = status()
    return current === "idle" ? props.row.title : `${props.row.title} · ${t(TITLE_SUFFIX[current])}`
  }
  return (
    <NavigationRow
      class="group/terminal"
      data={{ "data-testid": "rail-sidebar-terminal-row", "data-terminal-id": props.row.terminalId }}
      classList={{ "bg-surface-base-hover": props.active, "pl-9": true }}
      label={title()}
      active={props.active}
      onActivate={() => terminals.open(props.row.placementId, props.row.terminalId)}
      engagement={engagement}
      prepareDrag={props.prepareDrag}
    >
      <NavigationRowGlyph>
        <Show
          when={status() !== "idle"}
          fallback={
            <span aria-hidden="true" data-slot="terminal-row-icon" class="flex items-center justify-center" classList={{ "text-text-strong": props.active, "text-icon-weak-base": !props.active }}>
              <Icon name="terminal" size="small" />
            </span>
          }
        >
          <NavigationStatusMark status={status()} />
        </Show>
      </NavigationRowGlyph>
      <span
        class="relative z-[1] pointer-events-none font-mono text-sm leading-tight truncate flex-1 min-w-0"
        classList={{ "text-text-strong font-semibold": props.active, "text-text-weak": !props.active }}
      >
        {title()}
      </span>
      <Tooltip placement="top" value={t("rail.terminal.close")}>
        <button
          type="button"
          aria-label={t("rail.terminal.closeNamed", { title: props.row.title })}
          data-slot="terminal-row-close"
          class="relative z-10 -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 leading-none text-icon-weak-base opacity-0 transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-strong-base group-hover/terminal:opacity-100 focus:opacity-100 focus-visible:bg-surface-base-hover focus-visible:outline-none"
          onClick={(event) => {
            event.stopPropagation()
            terminals.close(props.row.placementId, props.row.terminalId)
          }}
        >
          <ClaxedoIconV2 name="close-small" size="small" />
        </button>
      </Tooltip>
    </NavigationRow>
  )
}

export function useProjectTerminals(placementIds: () => readonly PlacementId[]): Accessor<readonly TerminalItem[]> {
  const terminals = useTerminals()
  createEffect(
    on(
      () => placementIds().join("\n"),
      () => {
        const releases = placementIds().map((placementId) => terminals.retain(placementId))
        onCleanup(() => releases.forEach((release) => release()))
      },
    ),
  )
  return createMemo(() => placementIds().flatMap((placementId) => terminals.items(placementId)))
}
