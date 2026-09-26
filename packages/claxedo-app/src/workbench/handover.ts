import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { unreachable } from "@/lib/machine"
import type { WorkbenchState } from "./types"

export type Handover =
  | { readonly kind: "settled" }
  | { readonly kind: "handing"; readonly serial: number; readonly paneId: string; readonly outgoing: string; readonly incoming: string }

export type HandoverEvent =
  | { readonly type: "assigned"; readonly serial: number; readonly paneId: string; readonly from: string | null; readonly to: string | null }
  | { readonly type: "revealed"; readonly serial: number }

export type Presence = "shown" | "incoming" | "outgoing" | "hidden"

export const SETTLED: Handover = { kind: "settled" }

export function handoverTransition(state: Handover, event: HandoverEvent): Handover {
  switch (event.type) {
    case "assigned": {
      const outgoing = state.kind === "handing" && state.paneId === event.paneId ? state.outgoing : event.from
      if (!outgoing || !event.to || outgoing === event.to) return SETTLED
      return { kind: "handing", serial: event.serial, paneId: event.paneId, outgoing, incoming: event.to }
    }
    case "revealed":
      return state.kind === "handing" && state.serial === event.serial ? SETTLED : state
    default:
      return unreachable(event)
  }
}

type Tracked = { readonly assigned: ReadonlyMap<string, string | null>; readonly serial: number; readonly state: Handover }

function trackAssignments(previous: Tracked, layout: WorkbenchState, revealed: number): Tracked {
  const assigned = new Map(layout.panes.map((pane) => [pane.id, pane.contentId]))
  let { serial, state } = previous
  for (const [paneId, to] of assigned) {
    const from = previous.assigned.get(paneId)
    if (from === undefined || from === to) continue
    serial += 1
    state = handoverTransition(state, { type: "assigned", serial, paneId, from, to })
  }
  if (state.kind === "handing") state = handoverTransition(state, { type: "revealed", serial: revealed })
  return { assigned, serial, state }
}

export type Handing = Extract<Handover, { kind: "handing" }>

function effective(state: Handover, layout: WorkbenchState): Handing | undefined {
  if (state.kind !== "handing") return undefined
  if (!layout.panes.some((pane) => pane.id === state.paneId && pane.contentId === state.incoming)) return undefined
  if (!layout.contentIds.includes(state.outgoing) || layout.panes.some((pane) => pane.contentId === state.outgoing)) return undefined
  return state
}

export function createHandover(input: { readonly layout: Accessor<WorkbenchState>; readonly revealed: (contentId: string) => boolean }): Accessor<Handing | undefined> {
  const [revealed, setRevealed] = createSignal(0)
  const tracked = createMemo<Tracked>((previous) => trackAssignments(previous, input.layout(), revealed()), { assigned: new Map(), serial: 0, state: SETTLED })
  const handing = createMemo(() => effective(tracked().state, input.layout()))
  createEffect(() => {
    const current = handing()
    if (current && input.revealed(current.incoming)) setRevealed(current.serial)
  })
  return handing
}

export function handoverPresence(handing: Accessor<Handing | undefined>, displayed: (contentId: string) => boolean) {
  return {
    presence: (contentId: string): Presence => {
      const current = handing()
      if (current?.incoming === contentId) return "incoming"
      if (current?.outgoing === contentId) return "outgoing"
      return displayed(contentId) ? "shown" : "hidden"
    },
    heldBy: (contentId: string) => (handing()?.outgoing === contentId ? handing()?.paneId : undefined),
  }
}
