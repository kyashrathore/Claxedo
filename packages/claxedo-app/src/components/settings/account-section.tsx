import { type Component, type JSX, Show, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useAuthSession } from "../../shell/auth/auth-session"

// Clerk's User object is loosely typed here; read the bits we render defensively.
type SignedInUser = {
  fullName?: string | null
  username?: string | null
  primaryEmailAddress?: { emailAddress?: string | null } | null
  emailAddresses?: ReadonlyArray<{ emailAddress?: string | null }> | null
  externalAccounts?: ReadonlyArray<{ provider?: string | null }> | null
}

function readEmail(user: SignedInUser | null): string | undefined {
  return user?.primaryEmailAddress?.emailAddress
    ?? user?.emailAddresses?.find((entry) => entry.emailAddress)?.emailAddress
    ?? undefined
}

function readMethod(user: SignedInUser | null): string {
  const provider = user?.externalAccounts?.find((account) => account.provider)?.provider
  if (!provider) return "Email code"
  // Clerk provider ids look like "oauth_google" → "Google".
  const name = provider.replace(/^oauth_/, "").replace(/_/g, " ")
  return name.charAt(0).toUpperCase() + name.slice(1)
}

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
  const auth = useAuthSession()
  const navigate = useNavigate()

  const identity = createMemo(() => {
    const current = auth.user() as SignedInUser | null
    const email = readEmail(current)
    if (!email && !current) return undefined
    return { email, name: current?.fullName ?? current?.username ?? undefined, method: readMethod(current) }
  })

  const handleSignOut = async () => {
    await auth.signOut()
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
