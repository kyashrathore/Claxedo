import { createMemo, type Accessor } from "solid-js"
import type { JSX } from "@solidjs/web"
import { useSpring } from "@opencode-ai/ui/motion-spring"

/**
 * The composer toolbar's two animated style bags.
 *
 * `buttons` fades and blurs the whole action cluster when shell mode takes over
 * the editor — shell mode has no model, agent, or attachment to configure, so
 * the row recedes rather than sitting there inert.
 *
 * `control` is `buttons` plus a fixed 28px height and a second, independent dim
 * for `pending`: while the harness is still polling, the "who answers" controls
 * are not yet trustworthy. That dim used to apply only to the inline agent chip,
 * which has since moved into the `+` menu, so it now rides the controls the
 * pending state actually concerns.
 */
export function createPromptToolbarMotion(input: { shellMode: Accessor<boolean>; pending: Accessor<boolean> }) {
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
