import { createMemo, type Accessor, type JSX } from "solid-js"
import { useSpring } from "@/ui"

export function createPromptToolbarMotion(input: {
  shellMode: Accessor<boolean>
  pending: Accessor<boolean>
}) {
  const spring = useSpring(() => (input.shellMode() ? 0 : 1), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number): JSX.CSSProperties => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? "auto" : "none",
  })
  const buttons = createMemo(() => motion(spring()))
  const control = createMemo<JSX.CSSProperties>(() => ({
    ...buttons(),
    height: "28px",
    opacity: spring() * (input.pending() ? 0.45 : 1),
  }))

  return { buttons, control }
}
