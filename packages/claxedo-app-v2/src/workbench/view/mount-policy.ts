import { createEffect, createSignal, type Accessor } from "solid-js"
import type { WorkbenchState } from "../types"

export const MAX_MOUNTED_CONTENTS = 8

export function createMountedContents(layout: Accessor<WorkbenchState>, assigned: Accessor<ReadonlySet<string>>): Accessor<readonly string[]> {
  const [activated, setActivated] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(() => {
    const current = assigned()
    setActivated((previous) => ([...current].every((id) => previous.has(id)) ? previous : new Set([...previous, ...current])))
  })
  return () => {
    const state = layout()
    const bound = assigned()
    const eligible = state.contentIds.filter((id) => bound.has(id) || activated().has(id))
    if (eligible.length <= MAX_MOUNTED_CONTENTS) return eligible
    const visible = eligible.filter((id) => bound.has(id))
    const retained = state.contentRecency
      .filter((id) => eligible.includes(id) && !bound.has(id))
      .slice(0, Math.max(0, MAX_MOUNTED_CONTENTS - visible.length))
    const selected = new Set([...visible, ...retained])
    return eligible.filter((id) => selected.has(id))
  }
}
