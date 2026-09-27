import { createEffect, createMemo, For, Show, type Component } from "solid-js"
import { TextField } from "@opencode-ai/ui/text-field"

export type ExecutionChoice = "local" | "cloud" | "connected"

/** Mints the single-use token, on a machine that is already signed in. */
const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
/** Run on the machine being added, with the token the invite printed. */
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

export const ExecutionStep: Component<{
  cloudAvailable: boolean
  localExecution: boolean
  choice: ExecutionChoice
  onChoice: (choice: ExecutionChoice) => void
  /** Whether the chosen row is in a state Finish can act on. */
  onReady: (ready: boolean) => void
}> = (props) => {
  const ready = createMemo(() => {
    if (props.choice === "local") return props.localExecution
    if (props.choice === "cloud") return props.cloudAvailable
    return props.localExecution
  })
  createEffect(() => props.onReady(ready()))

  const rows = createMemo<Array<{ id: ExecutionChoice; title: string; detail: string }>>(() => [
    ...(props.localExecution
      ? [{ id: "local" as const, title: "Just this machine", detail: "Sessions run on this computer, in the project's folder." }]
      : []),
    ...(props.cloudAvailable ? [{
      id: "cloud" as const,
      title: "A cloud sandbox",
      detail: "Sessions run in a sandbox the connected control plane provides.",
    }] : []),
    { id: "connected" as const, title: "Another machine", detail: "A computer you connect with the Claxedo CLI serves the work." },
  ])

  return (
    <div class="flex flex-col gap-4" data-slot="onboarding-execution">
      <div role="radiogroup" aria-label="Where work runs" class="flex flex-col gap-2">
        <For each={rows()}>
          {(row) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.choice === row.id}
              data-choice={row.id}
              class="flex flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
              onClick={() => props.onChoice(row.id)}
            >
              <span class="text-14-medium text-text-strong">{row.title}</span>
              <span class="text-12-regular text-text-weak">{row.detail}</span>
            </button>
          )}
        </For>
      </div>

      <Show when={props.choice === "cloud" && props.cloudAvailable}>
        <p class="text-13-regular text-text-weak" data-slot="onboarding-cloud-hosted">
          The connected control plane provides the sandbox; there is nothing to configure here.
        </p>
      </Show>

      <Show when={props.choice === "connected"}>
        <div class="flex flex-col gap-3" data-slot="onboarding-machine">
          <p class="text-13-regular text-text-weak">
            Connecting a machine takes two commands: one here, one on that machine.
          </p>
          <TextField label="On a signed-in machine" value={INVITE_COMMAND} readOnly copyable />
          <TextField label="On the machine being added" value={CONNECT_COMMAND} readOnly copyable />
          <p class="text-12-regular text-text-weak">
            <Show
              when={props.localExecution}
              fallback="Nothing can send this repository to a machine you connect yet, so pick the cloud sandbox to start; a connected machine's own folders appear as projects once it serves them."
            >
              Machines you connect appear in Settings → Machines. This project opens on this computer for now.
            </Show>
          </p>
        </div>
      </Show>
    </div>
  )
}
