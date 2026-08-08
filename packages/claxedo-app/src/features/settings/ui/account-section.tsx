import { type Component, type JSX, Show, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useAccountPort } from "@/platform/account/account-provider"

type AccountSettingsSectionProps = {
  t: (key: string) => string
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
      <h3 class="text-14-medium text-text-strong pb-2">
        {props.t("settings.general.section.account")}
      </h3>

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
