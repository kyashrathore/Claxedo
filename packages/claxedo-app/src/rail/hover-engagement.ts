import { createSignal, onCleanup, type Accessor } from "solid-js"

export type HoverEngagement = {
  readonly engaged: Accessor<boolean>
  readonly hovered: Accessor<boolean>
  readonly hold: () => void
  readonly release: () => void
  readonly handlers: {
    readonly onPointerEnter: () => void
    readonly onPointerLeave: () => void
    readonly onFocusIn: () => void
    readonly onFocusOut: (event: FocusEvent) => void
  }
}

type Reason = "hovered" | "focused" | "held"

function createEngagedState(releaseDelayMs: number) {
  const [engaged, setEngaged] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)
  const reasons: Record<Reason, boolean> = { hovered: false, focused: false, held: false }
  let pending: ReturnType<typeof setTimeout> | undefined
  const wanted = () => reasons.hovered || reasons.focused || reasons.held
  const cancel = () => {
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
  }
  const settle = () => {
    if (wanted()) {
      cancel()
      setEngaged(true)
      return
    }
    if (!engaged() || pending !== undefined) return
    if (releaseDelayMs <= 0) {
      setEngaged(false)
      return
    }
    pending = setTimeout(() => {
      pending = undefined
      setEngaged(wanted())
    }, releaseDelayMs)
  }
  onCleanup(cancel)
  const set = (reason: Reason, value: boolean) => {
    reasons[reason] = value
    if (reason === "hovered") setHovered(value)
    settle()
  }
  return { engaged, hovered, set }
}

function engagementHandlers(set: (reason: Reason, value: boolean) => void): HoverEngagement["handlers"] {
  return {
    onPointerEnter: () => set("hovered", true),
    onPointerLeave: () => set("hovered", false),
    onFocusIn: () => set("focused", true),
    onFocusOut: (event) => {
      const next = event.relatedTarget
      const host = event.currentTarget
      if (next instanceof Node && host instanceof Node && host.contains(next)) return
      set("focused", false)
    },
  }
}

export function createHoverEngagement(input?: { readonly releaseDelayMs?: number }): HoverEngagement {
  const state = createEngagedState(input?.releaseDelayMs ?? 0)
  return {
    engaged: state.engaged,
    hovered: state.hovered,
    hold: () => state.set("held", true),
    release: () => state.set("held", false),
    handlers: engagementHandlers(state.set),
  }
}
