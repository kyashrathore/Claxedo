import "#app-v2/styles"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import type { InitStep } from "../preload/types"
import { desktopApi } from "../renderer/api"

const STATUS: Record<InitStep["phase"], string> = {
  server_waiting: "Starting Claxedo",
  sqlite_waiting: "Migrating your database",
  done: "Ready",
}

function DesktopStartupStatus() {
  const [step, setStep] = createSignal<InitStep>({ phase: "server_waiting" })
  const [failure, setFailure] = createSignal<string>()
  desktopApi()
    .awaitInitialization(setStep)
    .then(
      () => setStep({ phase: "done" }),
      (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
    )
  createEffect(() => {
    if (step().phase !== "done") return
    const timer = setTimeout(() => desktopApi().loadingWindowComplete(), 300)
    onCleanup(() => clearTimeout(timer))
  })
  return (
    <main style={{ display: "grid", "place-items": "center", height: "100vh", color: "var(--text-base, #a0a0a0)" }}>
      <Show when={failure()} fallback={<p role="status">{STATUS[step().phase]}</p>}>
        {(message) => <p role="alert">Claxedo could not start: {message()}</p>}
      </Show>
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("The loading document has no #root element")
render(() => <DesktopStartupStatus />, root)
