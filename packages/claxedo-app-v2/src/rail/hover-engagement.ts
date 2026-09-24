import { createSignal, onCleanup, type Accessor } from "solid-js"

export type HoverEngagement = {
  readonly engaged: Accessor<boolean>
  readonly hold: () => void
  readonly release: () => void
  readonly handlers: {
    readonly onPointerEnter: () => void
    readonly onPointerLeave: () => void
    readonly onFocusIn: () => void
    readonly onFocusOut: (event: FocusEvent) => void
  }
}

export function createHoverEngagement(input?: { readonly releaseDelayMs?: number }): HoverEngagement {
  const releaseDelayMs = input?.releaseDelayMs ?? 0
  const [engaged, setEngaged] = createSignal(false)
  const reasons = { hovered: false, focused: false, held: false }
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
    if (releaseDelayMs <= 0) return void setEngaged(false)
    pending = setTimeout(() => {
      pending = undefined
      setEngaged(wanted())
    }, releaseDelayMs)
  }
  const set = (reason: keyof typeof reasons, value: boolean) => {
    reasons[reason] = value
    settle()
  }
  onCleanup(cancel)
  return {
    engaged,
    hold: () => set("held", true),
    release: () => set("held", false),
    handlers: {
      onPointerEnter: () => set("hovered", true),
      onPointerLeave: () => set("hovered", false),
      onFocusIn: () => set("focused", true),
      onFocusOut: (event) => {
        const next = event.relatedTarget
        const host = event.currentTarget
        if (next instanceof Node && host instanceof Node && host.contains(next)) return
        set("focused", false)
      },
    },
  }
}
