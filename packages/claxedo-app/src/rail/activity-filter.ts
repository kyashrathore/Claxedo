import { machine, unreachable, type Machine } from "@/lib/machine"
import type { ActivityFilter } from "@/session"

export type ActivityFilterState = { readonly kind: ActivityFilter }

export type ActivityFilterEvent = { readonly type: "cycled" }

const NEXT: Readonly<Record<ActivityFilter, ActivityFilter>> = { all: "working", working: "needsYou", needsYou: "all" }

export function activityFilterTransition(state: ActivityFilterState, event: ActivityFilterEvent): ActivityFilterState {
  switch (event.type) {
    case "cycled":
      return { kind: NEXT[state.kind] }
    default:
      return unreachable(event.type)
  }
}

export const createActivityFilter = (): Machine<ActivityFilterState, ActivityFilterEvent> => machine({ kind: "all" }, activityFilterTransition)
