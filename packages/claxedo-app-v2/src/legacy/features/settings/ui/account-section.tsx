import { type Component, type JSX, Show, createMemo, createResource, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { useAccountPort } from "@/platform/account/account-provider"
import type { AgentSettingsApi } from "@/features/settings/data/agent-settings-api"

type AccountSettingsSectionProps = {
  t: (key: string) => string
  agentSettings: AgentSettingsApi
}

const SettingsRow: Component<{
  title: string
  description: string
  children: JSX.Element
}> = (props) => {
  return (
    <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}

/**
 * "Agents may act on my other machines". The switch shows what the control
 * plane holds, never what was last clicked: a write is read back from its
 * answer, and a refused write leaves the switch where the server left it.
 */
const AgentSettingsRow: Component<{ t: (key: string) => string; api: AgentSettingsApi }> = (props) => {
  const [stored, { mutate }] = createResource(() => props.api.read())
  const [writing, setWriting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const unavailable = () => {
    const error: unknown = stored.error
    if (!error) return undefined
    return error instanceof Error && error.message ? error.message : props.t("settings.general.account.agents.unavailable")
  }
  const checked = () => (unavailable() ? false : stored()?.crossMachineWrites ?? false)
  const disabled = () => stored.loading || unavailable() !== undefined || writing()

  const flip = async (crossMachineWrites: boolean) => {
    if (disabled()) return
    setWriting(true)
    setFailure()
    try {
      mutate(await props.api.write({ crossMachineWrites }))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : props.t("settings.general.account.agents.unavailable"))
    } finally {
      setWriting(false)
    }
  }

  return (
    <>
      <SettingsRow
        title={props.t("settings.general.account.agents.title")}
        description={props.t("settings.general.account.agents.description")}
      >
        <div data-action="settings-account-agents-cross-machine">
          <Switch hideLabel checked={checked()} disabled={disabled()} onChange={(value: boolean) => void flip(value)}>
            {props.t("settings.general.account.agents.title")}
          </Switch>
        </div>
      </SettingsRow>
      <Show when={unavailable() ?? failure()}>
        {(message) => <p role="alert" class="pb-3 text-12-regular text-icon-critical-base">{message()}</p>}
      </Show>
    </>
  )
}

export const AccountSettingsSection: Component<AccountSettingsSectionProps> = (props) => {
  // Reads the account through the port, not the session. On desktop the same
  // component will be reading state that arrived over IPC from a process this
  // one cannot borrow a credential from, and nothing here changes.
  const account = useAccountPort()
  const navigate = useNavigate()

  const identity = createMemo(() => {
    const state = account.state()
    if (state.status !== "signed") return undefined
    const { email, displayName, method } = state.identity
    if (!email && !displayName) return undefined
    return { email, name: displayName, method: method ?? "Email code" }
  })

  const handleSignOut = async () => {
    await account.signOut()
    navigate("/login", { replace: true })
  }

  return (
    <div class="flex flex-col gap-1">
      <h2 class="text-14-medium text-text-strong pb-2">
        {props.t("settings.general.section.account")}
      </h2>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <Show when={identity()}>
          {(info) => (
            <SettingsRow
              title={info().email ?? info().name ?? "Signed in"}
              description={`Signed in via ${info().method}`}
            >
              <span class="text-12-regular text-text-weak">{info().name && info().email ? info().name : ""}</span>
            </SettingsRow>
          )}
        </Show>
        <Show when={account.state().status === "signed"}>
          <AgentSettingsRow t={props.t} api={props.agentSettings} />
        </Show>
        <SettingsRow
          title={props.t("settings.general.account.logout.title")}
          description={props.t("settings.general.account.logout.description")}
        >
          <Button size="small" variant="secondary" onClick={() => void handleSignOut()}>
            {props.t("settings.general.account.logout.button")}
          </Button>
        </SettingsRow>
      </div>
    </div>
  )
}
