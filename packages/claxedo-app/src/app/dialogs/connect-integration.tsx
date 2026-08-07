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
} from "../../features/settings/ui/connections-logic"

export function DialogConnectIntegration(props: {
  integration: IntegrationInfo
  request: ConnectionsRequest
  onConnected?: () => void | Promise<void>
  personalScopeEnabled?: boolean
  initialScope?: "team" | "personal"
}) {
  const dialog = useDialog()
  const flow = createConnectFlow({
    integration: props.integration,
    request: props.request,
    personalScopeEnabled: props.personalScopeEnabled,
    initialScope: props.initialScope,
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
        <Show when={props.personalScopeEnabled}>
          <div class="flex flex-col gap-2">
            <span class="text-13-medium text-text-strong">Connection scope</span>
            <div class="flex flex-col gap-2 text-13-regular text-text-base" role="radiogroup" aria-label="Connection scope">
              <label class="flex items-center gap-2">
                <input
                  type="radio"
                  name="connection-scope"
                  checked={flow.state.scope === "team"}
                  onChange={() => flow.setScope("team")}
                />
                <span>Team — anyone on this host can use it</span>
              </label>
              <label class="flex items-center gap-2">
                <input
                  type="radio"
                  name="connection-scope"
                  checked={flow.state.scope === "personal"}
                  onChange={() => flow.setScope("personal")}
                />
                <span>Only me — used only in your interactive turns</span>
              </label>
            </div>
          </div>
        </Show>
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
            <div class="flex flex-col gap-3">
              {/*
                A device grant sends the user to a page that ASKS for a code,
                and this response is the only place that code exists. Showing
                just the spinner left the user stuck on that page with nothing
                to type, so the flow could never complete however long it
                polled. Selectable and monospaced because it gets typed by hand.
              */}
              <Show when={flow.state.userCode}>
                {(code) => (
                  <div class="flex flex-col gap-1">
                    <span class="text-13-medium text-text-strong">Enter this code to authorize</span>
                    <span
                      data-testid="device-user-code"
                      class="select-all font-mono text-18-medium tracking-[var(--letter-spacing-code)] text-text-strong"
                    >
                      {code()}
                    </span>
                    <Show when={flow.state.verificationUrl}>
                      {(url) => (
                        <a
                          class="text-13-regular text-text-interactive-base"
                          href={url()}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open {props.integration.name} to enter it
                        </a>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
              <div class="flex items-center gap-2 text-14-regular text-text-base">
                <Spinner />
                <span>Waiting for authorization in your browser…</span>
              </div>
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
