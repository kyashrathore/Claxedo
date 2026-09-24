import { createMemo, Show, type JSX } from "solid-js"
import { useAuth } from "@/auth"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer } from "@/server"
import { settingsPath, useShellRoute } from "@/shell"
import { showToast } from "@/ui"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { dictionary } from "../i18n"

const HELP_URL = "https://github.com/kyashrathore/Claxedo"
export const USAGE_SECTION = "usage"

type AccountView = {
  readonly signed: boolean
  readonly pending: boolean
  readonly local: boolean
  readonly label: string
  readonly image: string | undefined
  readonly action: "signin" | "logout" | undefined
}

function useAccountView() {
  const t = useTranslator(dictionary)
  const auth = useAuth()
  const server = useServer()
  return createMemo((): AccountView => {
    const state = auth.state()
    const offered = server.capabilities()?.signedIn === true && auth.unavailable() === null
    const pending = state.kind === "signingIn"
    const base = { pending, local: !pending && state.kind !== "signedIn" && !offered }
    if (state.kind === "signedIn") {
      const label = state.user.fullName ?? state.user.email ?? t("rail.account.signedIn")
      return { ...base, signed: true, label, image: state.user.imageUrl, action: "logout" }
    }
    if (pending) return { ...base, signed: false, label: t("rail.account.signingIn"), image: undefined, action: undefined }
    const label = offered ? t("rail.account.signIn") : t("rail.account.notSignedIn")
    return { ...base, signed: false, label, image: undefined, action: offered ? "signin" : undefined }
  })
}

function IdentityMark(props: { readonly view: AccountView; readonly size: "trigger" | "row" }): JSX.Element {
  const box = () => (props.size === "trigger" ? "size-7" : "size-5")
  return (
    <Show
      when={!props.view.pending}
      fallback={
        <span class={`flex ${box()} shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base`} aria-hidden="true">
          <Spinner class={props.size === "trigger" ? "size-3.5" : "size-3"} />
        </span>
      }
    >
      <Show
        when={props.view.signed}
        fallback={
          <span class={`flex ${box()} shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base`} aria-hidden="true">
            <Icon name={props.view.local ? "monitor" : "arrow-right"} size="small" />
          </span>
        }
      >
        <Avatar fallback={props.view.label} src={props.view.image} size="small" class="shrink-0" aria-hidden="true" />
      </Show>
    </Show>
  )
}

export function AccountCard(): JSX.Element {
  const t = useTranslator(dictionary)
  const auth = useAuth()
  const routing = useShellRoute()
  const view = useAccountView()
  let trigger: HTMLButtonElement | undefined
  const select = (action: () => void) => () => {
    trigger?.focus()
    action()
  }
  const settle = (work: Promise<void>, title: string) =>
    void work.catch((error: unknown) => {
      showToast({ title, description: failureMessage(error) })
    })
  const signIn = () => settle(auth.signIn({ redirectUrl: window.location.href }), t("rail.account.signInFailed"))
  const signOut = () => settle(auth.signOut(), t("rail.account.signOutFailed"))
  return (
    <DropdownMenu placement="top-start" gutter={6} sameWidth>
      <DropdownMenu.Trigger
        ref={(element: HTMLButtonElement) => (trigger = element)}
        aria-label={view().label}
        title={view().label}
        class="group flex h-9 w-full items-center gap-2 rounded-md border border-transparent bg-surface-raised-base px-2 text-left text-text-strong outline-none transition-colors hover:bg-surface-raised-base-hover focus-visible:border-border-focus data-[expanded]:bg-surface-raised-base-hover"
        data-testid="rail-account-trigger"
      >
        <IdentityMark view={view()} size="trigger" />
        <span data-slot="rail-account-label" class="min-w-0 flex-1 truncate text-13-medium">
          {view().label}
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 rotate-180 text-icon-weak-base opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[expanded]:opacity-100" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-[220]" style={{ "max-width": "calc(100vw - 16px)" }}>
          <div class="flex items-center gap-2 px-2 py-1" aria-hidden="true">
            <IdentityMark view={view()} size="row" />
            <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong" title={view().label}>
              {view().label}
            </span>
          </div>
          <DropdownMenu.Separator />
          <DropdownMenu.Group>
            <DropdownMenu.Item onSelect={select(() => routing.navigate(settingsPath(USAGE_SECTION)))}>
              <Icon name="gauge" size="small" />
              <DropdownMenu.ItemLabel>{t("rail.account.usage")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={select(() => routing.navigate(settingsPath()))}>
              <Icon name="settings-gear" size="small" />
              <DropdownMenu.ItemLabel>{t("rail.settings")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={select(() => window.open(HELP_URL, "_blank", "noopener,noreferrer"))}>
              <Icon name="help" size="small" />
              <DropdownMenu.ItemLabel>{t("rail.account.help")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <Show when={view().pending}>
            <DropdownMenu.Item onSelect={signOut}>
              <Icon name="circle-ban-sign" size="small" />
              <DropdownMenu.ItemLabel>{t("rail.account.cancelSignIn")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <Show when={view().action}>
            {(action) => (
              <DropdownMenu.Item onSelect={action() === "signin" ? signIn : signOut}>
                <Icon name="arrow-right" size="small" />
                <DropdownMenu.ItemLabel>{action() === "signin" ? t("rail.account.signIn") : t("rail.account.logout")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            )}
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
