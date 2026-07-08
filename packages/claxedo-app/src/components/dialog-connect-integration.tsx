// Connect dialog for the Connections settings section. Renders the
// integration's prompts dynamically (secret prompts as password inputs) or a
// single "Continue with OAuth" action for oauth-only integrations, and walks
// the connect flow state machine (confirm-replace on 409, attempt polling for
// oauth). Secrets are cleared when the dialog unmounts.
import { Match, onCleanup, Show, Switch, For } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import {
  createConnectFlow,
  isOAuthOnly,
  type ConnectionsRequest,
  type IntegrationInfo,
} from "./settings-connections-core"

export function DialogConnectIntegration(props: {
  integration: IntegrationInfo
  request: ConnectionsRequest
  onConnected?: () => void | Promise<void>
}) {
  const dialog = useDialog()
  const flow = createConnectFlow({
    integration: props.integration,
    request: props.request,
    openUrl: (url) => window.open(url, "_blank", "noopener"),
    onConnected: async () => {
      await props.onConnected?.()
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: `${props.integration.name} connected`,
      })
    },
  })

  // Clears fields and the secret (and cancels oauth polling) on close.
  onCleanup(() => flow.reset())

  const busy = () => flow.state.phase === "submitting" || flow.state.phase === "oauth-waiting"
  const oauthOnly = () => isOAuthOnly(props.integration)

  return (
    <Dialog title={`Connect ${props.integration.name}`} transition>
      <div class="flex flex-col gap-4">
        <Switch>
          <Match when={flow.state.phase === "confirm-replace"}>
            <div class="flex flex-col gap-4">
              <div class="text-14-regular text-text-base">
                A connection to {props.integration.name} already exists. Replace the existing connection?
              </div>
              <div class="flex items-center gap-2">
                <Button size="large" variant="primary" disabled={busy()} onClick={() => void flow.confirmReplace()}>
                  Replace
                </Button>
                <Button size="large" variant="secondary" disabled={busy()} onClick={() => flow.cancelReplace()}>
                  Cancel
                </Button>
              </div>
            </div>
          </Match>
          <Match when={flow.state.phase === "oauth-waiting"}>
            <div class="flex items-center gap-2 text-14-regular text-text-base">
              <Spinner />
              <span>Waiting for authorization in your browser…</span>
            </div>
          </Match>
          <Match when={oauthOnly()}>
            <div class="flex flex-col items-start gap-4">
              <div class="text-14-regular text-text-base">
                Authorize Claxedo to access your {props.integration.name} account.
              </div>
              <Show when={flow.state.error}>
                {(error) => <div class="text-14-regular text-icon-critical-base">{error()}</div>}
              </Show>
              <Button size="large" variant="primary" disabled={busy()} onClick={() => void flow.startOAuth()}>
                Continue with OAuth
              </Button>
            </div>
          </Match>
          <Match when={true}>
            <form
              class="flex flex-col items-start gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void flow.submitKey()
              }}
            >
              <For each={props.integration.prompts ?? []}>
                {(prompt) => (
                  <TextField
                    type={prompt.secret ? "password" : "text"}
                    label={prompt.label}
                    placeholder={prompt.placeholder}
                    autocomplete="off"
                    value={prompt.secret ? flow.state.secret : (flow.state.fields[prompt.id] ?? "")}
                    onChange={(value: string) => {
                      if (prompt.secret) flow.setSecret(value)
                      else flow.setField(prompt.id, value)
                    }}
                  />
                )}
              </For>
              <Show when={flow.state.error}>
                {(error) => <div class="text-14-regular text-icon-critical-base">{error()}</div>}
              </Show>
              <Button class="w-auto" type="submit" size="large" variant="primary" disabled={busy()}>
                {flow.state.phase === "submitting" ? "Connecting…" : "Connect"}
              </Button>
            </form>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
