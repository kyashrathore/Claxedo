import { createTrackedEffect, createMemo, createSignal, onCleanup, onSettled, Show, type Accessor } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import { panePreferenceScope } from "@/features/session/preferences/pane"

/**
 * Interval for the standing harness-health poll. The harness config route
 * (`GET /api/claxedo/agent-config/harness`, proxying `/api/wr/health`) is
 * otherwise fetched only at load / harness-switch and, for a slow harness, by
 * the bounded reprobe loop *while polling* — nothing re-checks a harness that
 * has already settled to "ready". Without a standing poll a harness that dies
 * after settling is invisible until the next send, so the "peek appears within
 * one poll interval" acceptance criterion (T4) depends on this.
 */
export const HARNESS_HEALTH_POLL_INTERVAL_MS = 20_000

/**
 * A quiet advisory rendered in the composer `beforeInput` slot when the selected
 * harness is degraded (its process was lost / is recovering). It names the
 * condition above the composer *before* the user types and pairs with the Send
 * gate (`harnessReadyForSubmit` returns false on "degraded"). Muted anatomy
 * (§2): one line, no fill, no rail — a 16px `--icon-warning-base` glyph + text +
 * a small secondary button. Renders nothing (zero chrome / zero layout shift) on
 * a healthy session.
 *
 * Reactivity gotcha (§2 constraint 6): the `beforeInput` slot is a plain
 * `JSX.Element` evaluated once, so the health subscription and the standing poll
 * live *inside* this component, never in the caller's synchronous body.
 */
export function SessionHealthPeek(props: {
  directory: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
  /** Test seam: override the standing poll cadence. */
  intervalMs?: number
}) {
  const controllers = usePromptHarnessControllersOptional()
  const selection = controllers.selection

  const scope = createMemo(() => panePreferenceScope({ directory: props.directory(), sessionId: props.sessionId() }))

  const readiness = createMemo(() => selection?.read(scope()).readiness ?? "ready")
  const degraded = createMemo(() => readiness() === "degraded")

  const probe = () => {
    const directory = props.directory()
    if (!selection || !directory) return
    void selection.probeHealth(scope(), { directory, sessionId: props.sessionId() })
  }

  // Standing poll: re-check harness health on a modest interval while this peek
  // is mounted (i.e. while the session screen is active). onCleanup stops it on
  // dispose / scope change. An immediate probe on (re)mount keeps first paint
  // fresh rather than waiting a full interval. `probeHealth` hits the harness
  // route directly (not `reprobe`, which short-circuits an existing session on
  // its stored config and never sees live degradation).
  //
  // A hidden window skips the tick — polling a window nobody can see spends
  // network and server CPU for a peek that cannot be read. The visibilitychange
  // probe below re-checks the moment the window returns, so T4's "within one
  // poll interval" holds for any visible window.
  createTrackedEffect(() => {
    if (!selection) return
    // Track the scope so a session/directory change restarts the poll.
    scope()
    props.directory()
    probe()
    const tick = () => {
      if (document.visibilityState !== "visible") return
      probe()
    }
    const id = setInterval(tick, props.intervalMs ?? HARNESS_HEALTH_POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  })

  return (
    <Show when={degraded()}>
      <HealthPeekRow onCheckAgain={probe} />
    </Show>
  )
}

function HealthPeekRow(props: { onCheckAgain: () => void }) {
  // Enter transition (no framer-motion): mount at opacity 0 / translateY(4px),
  // flip on the next frame so the CSS transition animates it in (feel-rule F4).
  const [entered, setEntered] = createSignal(false)
  onSettled(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  })
  return (
    <div
      data-testid="session-health-peek"
      role="status"
      style={{
        opacity: entered() ? "1" : "0",
        transform: entered() ? "translateY(0)" : "translateY(4px)",
        transition: "opacity .2s ease, transform .2s ease",
      }}
    >
      <div class="flex items-center gap-2 pb-2 text-13-regular">
        <Icon name="warning" class="size-4 shrink-0 text-icon-warning-base" />
        <span class="min-w-0 flex-1 truncate text-text-strong">The agent stopped responding</span>
        <Button size="small" variant="secondary" onClick={props.onCheckAgain}>
          Check again
        </Button>
      </div>
    </div>
  )
}
