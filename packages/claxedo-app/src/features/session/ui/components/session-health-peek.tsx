import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import { panePreferenceScope } from "@/features/session/preferences/pane"

/**
 * The harness config route (`GET /api/claxedo/agent-config/harness`, proxying
 * `/api/wr/health`) is otherwise fetched only at load / harness-switch and by
 * the bounded reprobe loop while polling; nothing re-checks a harness that has
 * settled to "ready". Without this standing poll a harness that dies after
 * settling stays invisible until the next send.
 */
export const HARNESS_HEALTH_POLL_INTERVAL_MS = 20_000

/**
 * A quiet advisory in the composer `beforeInput` slot when the selected harness
 * is degraded (its process was lost / is recovering). It names the condition
 * before the user types and pairs with the Send gate (`harnessReadyForSubmit`
 * is false on "degraded"): one line, no fill, no rail — a 16px
 * `--icon-warning-base` glyph, text, and a small secondary button. Renders
 * nothing on a healthy session.
 *
 * The `beforeInput` slot is a plain `JSX.Element` evaluated once, so the health
 * subscription and the standing poll must live inside this component, not in
 * the caller's synchronous body.
 */
export function SessionHealthPeek(props: {
  directory: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
  /** True only while this exact session owns an active turn. */
  turnActive: Accessor<boolean>
  /** Whether this retained session pane is the one currently painted. */
  active: Accessor<boolean>
  /** Test seam: override the standing poll cadence. */
  intervalMs?: number
}) {
  const controllers = usePromptHarnessControllersOptional()
  const selection = controllers.selection

  const scope = createMemo(() =>
    panePreferenceScope({ directory: props.directory(), sessionId: props.sessionId() }),
  )

  const readiness = createMemo(() => selection?.read(scope()).readiness ?? "ready")
  const selectedHarness = createMemo(() => {
    const harness = selection?.read(scope()).harness
    return harness?.kind === "connection" ? `connection:${harness.connectionId}` : harness?.kind === "native" ? `native:${harness.harnessId}` : undefined
  })
  const degraded = createMemo(() => props.turnActive() && readiness() === "degraded")

  const probe = () => {
    const directory = props.directory()
    if (!selection || !directory) return
    void selection.probeHealth(scope(), { directory, sessionId: props.sessionId() })
  }

  // Standing poll: re-check harness health on a modest interval while this peek
  // belongs to the active session pane. Retained inactive panes stay mounted but
  // own no timer or document listener. onCleanup stops both on deactivation,
  // dispose, or scope change. An immediate probe on activation keeps first paint
  // fresh rather than waiting a full interval. `probeHealth` hits the harness
  // route directly (not `reprobe`, which short-circuits an existing session on
  // its stored config and never sees live degradation).
  //
  // A hidden window skips the tick: polling a window nobody can see spends
  // network and server CPU for a peek nobody reads. The visibilitychange probe
  // re-checks the moment the window returns.
  createEffect(() => {
    // Session panes are retained across switches. Only the pane that is actually
    // painted owns this observer pair; reading `active` before the scope also
    // means identity changes in a retained inactive pane do not wake it. A
    // false→true transition enters this effect once and performs the one
    // immediate catch-up probe before arming its standing observers.
    if (!selection || !props.active()) return
    // Track the scope so a session/directory change restarts the poll.
    scope()
    selectedHarness()
    props.directory()
    probe()
    // Idle and past sessions receive the catch-up probe above so stale
    // availability is cleared, but they never own a standing liveness poll.
    // A process-loss diagnosis is meaningful only while this exact session has
    // an active turn to correlate it with.
    if (!props.turnActive()) return
    const tick = () => {
      if (document.visibilityState !== "visible") return
      probe()
    }
    const id = setInterval(tick, props.intervalMs ?? HARNESS_HEALTH_POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    })
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
  onMount(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    onCleanup(() => cancelAnimationFrame(raf))
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
        <Icon name="warning" class="size-4 m-0.5 shrink-0 text-icon-warning-base" />
        <span class="min-w-0 flex-1 truncate text-text-strong">The agent stopped responding</span>
        <Button size="small" variant="secondary" onClick={props.onCheckAgain}>
          Check again
        </Button>
      </div>
    </div>
  )
}
