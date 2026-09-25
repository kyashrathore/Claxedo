import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ClaxedoIcon as Icon, Button } from "@/ui"
import type { ComposerSetup } from "../setup"

export const HARNESS_HEALTH_POLL_INTERVAL_MS = 20_000

export function SessionHealthPeek(props: { composer: ComposerSetup; active: () => boolean }) {
  const scope = () => props.composer.key()
  const readiness = createMemo(() => props.composer.harnessController.read(scope()).readiness)
  const selectedHarness = createMemo(() => {
    const harness = props.composer.harnessController.read(scope()).harness
    return harness?.kind === "connection" ? `connection:${harness.connectionId}` : harness?.kind === "native" ? `native:${harness.harnessId}` : undefined
  })
  const turnActive = () => props.composer.working()
  const degraded = createMemo(() => turnActive() && readiness() === "degraded")
  const probe = () => void props.composer.harnessController.probeHealth(scope(), props.composer.harnessScopeInput())

  createEffect(() => {
    if (!props.active()) return
    scope()
    selectedHarness()
    probe()
    if (!turnActive()) return
    const tick = () => {
      if (document.visibilityState === "visible") probe()
    }
    const id = setInterval(tick, HARNESS_HEALTH_POLL_INTERVAL_MS)
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
      <HealthPeekRow onCheckAgain={probe} text={props.composer.t("composer.health.stopped")} action={props.composer.t("composer.health.checkAgain")} />
    </Show>
  )
}

function HealthPeekRow(props: { onCheckAgain: () => void; text: string; action: string }) {
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
        <span class="min-w-0 flex-1 truncate text-text-strong">{props.text}</span>
        <Button size="small" variant="secondary" onClick={props.onCheckAgain}>
          {props.action}
        </Button>
      </div>
    </div>
  )
}
