import { createSignal, onCleanup, type Accessor } from "solid-js"

export type HoverEngagement = {
  readonly engaged: Accessor<boolean>
  readonly hovered: Accessor<boolean>
  readonly focusedTarget: Accessor<HTMLElement | undefined>
  readonly hold: () => void
  readonly release: () => void
  readonly handlers: {
    readonly onPointerEnter: () => void
    readonly onPointerLeave: () => void
    readonly onFocusIn: (event: FocusEvent) => void
    readonly onFocusOut: (event: FocusEvent) => void
  }
}

type Reason = "hovered" | "focused" | "held"
type EngagementReasons = { readonly hovered: boolean; readonly focused: HTMLElement | undefined; readonly held: boolean }

function createEngagedState(releaseDelayMs: number) {
  const [engaged, setEngaged] = createSignal(false)
  const [reasons, setReasons] = createSignal<EngagementReasons>({ hovered: false, focused: undefined, held: false })
  let pending: ReturnType<typeof setTimeout> | undefined
  const wanted = () => reasons().hovered || !!reasons().focused || reasons().held
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
    if (releaseDelayMs <= 0) return void setEngaged(false)
    pending = setTimeout(() => {
      pending = undefined
      setEngaged(wanted())
    }, releaseDelayMs)
  }
  onCleanup(cancel)
  const set = <Key extends Reason>(reason: Key, value: EngagementReasons[Key]) => {
    setReasons((current) => current[reason] === value ? current : { ...current, [reason]: value })
    settle()
  }
  return { engaged, set, hovered: () => reasons().hovered, focusedTarget: () => reasons().focused }
}

function engagementHandlers(set: ReturnType<typeof createEngagedState>["set"]): HoverEngagement["handlers"] {
  return {
    onPointerEnter: () => set("hovered", true),
    onPointerLeave: () => set("hovered", false),
    onFocusIn: (event) => set("focused", event.target instanceof HTMLElement ? event.target : undefined),
    onFocusOut: (event) => {
      const next = event.relatedTarget
      const host = event.currentTarget
      if (next instanceof Node && host instanceof Node && host.contains(next)) return
      set("focused", undefined)
    },
  }
}

export function createHoverEngagement(input?: { readonly releaseDelayMs?: number }): HoverEngagement {
  const state = createEngagedState(input?.releaseDelayMs ?? 0)
  return {
    engaged: state.engaged,
    hovered: state.hovered,
    focusedTarget: state.focusedTarget,
    hold: () => state.set("held", true),
    release: () => state.set("held", false),
    handlers: engagementHandlers(state.set),
  }
}
