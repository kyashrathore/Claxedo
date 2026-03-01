import { Splash } from "@opencode-ai/ui/logo"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createSignal, Show } from "solid-js"
import { commands } from "./bindings"

export function ActivationScreen(props: { onActivated: () => void }) {
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  async function handleActivate() {
    const trimmed = key().trim()
    if (!trimmed) return

    setError("")
    setLoading(true)

    try {
      await commands.activateLicense(trimmed)
      props.onActivated()
    } catch (e) {
      setError(typeof e === "string" ? e : "Activation failed")
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault()
      handleActivate()
    }
  }

  return (
    <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base">
      <div data-tauri-decorum-tb class="flex flex-row absolute top-0 right-0 z-10 h-10" />
      <div class="flex flex-col items-center gap-8 w-80">
        <Splash class="w-16 h-20 opacity-50" />
        <div class="flex flex-col items-center gap-2">
          <h1 class="text-16-semibold text-text-strong">Activate OpenCode</h1>
          <p class="text-13-normal text-text-dimmed text-center">
            Enter your license key to get started
          </p>
        </div>
        <div class="flex flex-col gap-4 w-full">
          <TextField
            label="License key"
            hideLabel
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={key()}
            onChange={setKey}
            onKeyDown={handleKeyDown}
            disabled={loading()}
            validationState={error() ? "invalid" : "valid"}
            error={error()}
          />
          <Button
            variant="primary"
            onClick={handleActivate}
            disabled={loading() || !key().trim()}
            class="w-full"
          >
            <Show when={loading()} fallback="Activate">
              <Spinner class="w-4 h-4" />
              Activating...
            </Show>
          </Button>
        </div>
        <a
          href="https://opencode.ai"
          target="_blank"
          class="text-13-normal text-text-dimmed hover:text-text-base transition-colors"
        >
          Don't have a license? Purchase one
        </a>
      </div>
    </div>
  )
}
