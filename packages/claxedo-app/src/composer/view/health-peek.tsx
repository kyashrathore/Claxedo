import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ClaxedoIcon as Icon, Button } from "@/ui"
import type { ComposerSetup } from "../setup"

export function SessionHealthPeek(props: { composer: ComposerSetup }) {
  const scope = () => props.composer.key()
  const readiness = createMemo(() => props.composer.harnessController.read(scope()).readiness)
  const degraded = createMemo(() => props.composer.working() && readiness() === "degraded")
  const probe = () => void props.composer.harnessController.probeHealth(scope(), props.composer.harnessScopeInput())

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
        <Button size="small" variant="neutral" onClick={props.onCheckAgain}>
          {props.action}
        </Button>
      </div>
    </div>
  )
}
