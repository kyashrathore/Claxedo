import { createEffect, createMemo, on, untrack, type Accessor } from "solid-js"
import type { SessionView } from "@/session"
import { holdPaneReveal } from "@/workbench"
import { messageNavVisible } from "./timeline"

function railNeedsOlder(view: SessionView): boolean {
  const turns = (view.conversation()?.messages ?? []).filter((message) => message.role === "user").length
  return !messageNavVisible(turns)
}

function fillDecision(view: SessionView): boolean | undefined {
  if (!view.conversation()) return undefined
  return untrack(() => view.hasOlder() && view.olderPagesLoaded() === 0 && railNeedsOlder(view))
}

function fillSettled(view: SessionView, fill: boolean): boolean {
  return !fill || !view.hasOlder() || view.olderPagesLoaded() > 0 || view.olderState().kind === "failed"
}

export function createFirstView(view: Accessor<SessionView>): Accessor<boolean> {
  const fill = createMemo<boolean | undefined>((decided) => decided ?? fillDecision(view()))
  createEffect(on(fill, (needed) => {
    if (needed) void view().loadOlder()
  }))
  const ready = createMemo<boolean>((was) => {
    const decided = fill()
    return was || (decided !== undefined && fillSettled(view(), decided))
  }, false)
  holdPaneReveal(() => !ready())
  return ready
}
