import { useContext } from "solid-js"
import { placementId, terminalId, type PlacementId, type TerminalId } from "@/server"
import type { Json, PaneKind } from "@/shell/types"
import { TerminalContext } from "./store"
import { TerminalPane } from "./view/terminal-pane"
import { t } from "./i18n"

export type TerminalPaneState = {
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
}

export const TERMINAL_PANE_KIND = "terminal"

export function terminalPaneState(state: TerminalPaneState): Json {
  return { placementId: state.placementId, terminalId: state.terminalId }
}

function decodeTerminalPaneState(value: Json): TerminalPaneState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as { readonly [key: string]: Json }
  const placement = record.placementId
  const terminal = record.terminalId
  if (typeof placement !== "string" || typeof terminal !== "string" || !placement || !terminal) return undefined
  return { placementId: placementId(placement), terminalId: terminalId(terminal) }
}

export const terminalPaneKind: PaneKind<TerminalPaneState> = {
  kind: TERMINAL_PANE_KIND,
  title: (state) => useContext(TerminalContext)?.store(state.placementId).row(state.terminalId)?.title ?? t("terminal.title"),
  icon: "terminal",
  view: TerminalPane,
  encode: terminalPaneState,
  decode: decodeTerminalPaneState,
}
