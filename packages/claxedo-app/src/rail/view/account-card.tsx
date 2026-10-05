import { useLocation } from "@solidjs/router"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { appUrl, useAuth } from "@/auth"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer } from "@/server"
import { settingsPath, useShellRoute } from "@/shell"
import { showToast, ClaxedoIcon as Icon, Avatar, DropdownMenu, Spinner } from "@/ui"
import { railDictionary } from "../i18n"
import { openExternal } from "@/lib/external-link"

const HELP_URL = "https://github.com/kyashrathore/Claxedo"
export const USAGE_SECTION = "usage"

type AccountView = {
  readonly signed: boolean
  readonly pending: boolean
  readonly resolving: boolean
  readonly local: boolean
  readonly label: string
  readonly image: string | undefined
  readonly action: "signin" | "logout" | undefined
}

function useAccountView() {
  const t = useTranslator(railDictionary)
  const auth = useAuth()
  const server = useServer()
  return createMemo((): AccountView => {
    const state = auth.state()
    const offered = auth.offered(server.capabilities()?.signedIn === true)
    const pending = state.kind === "signingIn"
    const base = { pending, resolving: pending || (state.kind === "signedIn" && auth.identityResolving()), local: !pending && state.kind !== "signedIn" && !offered }
    if (state.kind === "signedIn") {
      const label = state.user.fullName ?? state.user.email ?? t("rail.account.signedIn")
      return { ...base, signed: true, label, image: state.user.imageUrl, action: "logout" }
    }
    if (pending) return { ...base, signed: false, label: t("rail.account.signingIn"), image: undefined, action: undefined }
    const label = offered ? t("rail.account.signIn") : t("rail.account.notSignedIn")
    return { ...base, signed: false, label, image: undefined, action: offered ? "signin" : undefined }
  })
}

function IdentityMark(props: { readonly view: AccountView }): JSX.Element {
  return (
    <Show
      when={!props.view.resolving}
      fallback={
        <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base" aria-hidden="true">
          <Spinner class="size-3" />
        </span>
      }
    >
      <Show
        when={props.view.signed}
        fallback={
          <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base" aria-hidden="true">
            <Icon name={props.view.local ? "monitor" : "arrow-right"} size="small" />
          </span>
        }
      >
        <Avatar fallback={props.view.label} src={props.view.image} size="normal" aria-hidden="true" />
      </Show>
    </Show>
  )
}

export function AccountCard(props: { readonly anchor: () => HTMLElement | undefined }): JSX.Element {
  const t = useTranslator(railDictionary)
  const auth = useAuth()
  const routing = useShellRoute()
  const location = useLocation()
  const view = useAccountView()
  let trigger: HTMLButtonElement | undefined
  const [open, setOpen] = createSignal(false)
  const [signingOut, setSigningOut] = createSignal(false)
  const select = (action: () => void) => () => {
    trigger?.focus()
    action()
  }
  const settle = (work: Promise<void>, title: string) =>
    work.catch((error: unknown) => {
      showToast({ title, description: failureMessage(error) })
    })
  const signIn = () => void settle(auth.signIn({ redirectUrl: appUrl(location) }), t("rail.account.signInFailed"))
  const signOut = () => {
    setSigningOut(true)
    void settle(auth.signOut(), t("rail.account.signOutFailed")).finally(() => setSigningOut(false))
  }
  return (
    <DropdownMenu
      placement="top-start"
      gutter={6}
      sameWidth
      open={open() || signingOut()}
      onOpenChange={(next) => signingOut() || setOpen(next)}
      getAnchorRect={(trigger) => (props.anchor() ?? trigger)?.getBoundingClientRect()}
    >
      <DropdownMenu.Trigger
        ref={(element) => (trigger = element)}
        aria-label={view().label}
        title={view().label}
        class="sidebar-row group flex w-full items-center gap-2 px-2 text-left text-text-strong outline-none transition-colors hover:bg-[var(--row-surface-hover)] focus-visible:bg-[var(--row-surface-hover)] focus-visible:ring-2 focus-visible:ring-border-interactive-base data-[expanded]:bg-[var(--row-surface-hover)]"
        data-testid="rail-account-trigger"
      >
        <IdentityMark view={view()} />
        <span class="min-w-0 flex-1 truncate">
          {view().label}
        </span>
        <Icon name="chevron-down" size="small" class={`shrink-0 rotate-180 text-icon-weak-base opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100${open() ? " opacity-100" : ""}`} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content style={{ "max-width": "calc(100vw - 16px)" }}>
          <DropdownMenu.Group>
            <DropdownMenu.Item onSelect={select(() => routing.navigate(settingsPath(USAGE_SECTION)))}>
              <Icon name="gauge" size="small" />
              {t("rail.account.usage")}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={select(() => openExternal(HELP_URL))}>
              <Icon name="help" size="small" />
              {t("rail.account.help")}
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <Show when={view().pending}>
            <DropdownMenu.Item onSelect={() => void settle(auth.signOut(), t("rail.account.signOutFailed"))}>
              <Icon name="circle-ban-sign" size="small" />
              {t("rail.account.cancelSignIn")}
            </DropdownMenu.Item>
          </Show>
          <Show when={view().action === "signin"}>
            <DropdownMenu.Item onSelect={signIn}>
              <Icon name="arrow-right" size="small" />
              {t("rail.account.signIn")}
            </DropdownMenu.Item>
          </Show>
          <Show when={view().action === "logout"}>
            <DropdownMenu.Item closeOnSelect={false} disabled={signingOut()} onSelect={signOut}>
              <Show when={signingOut()} fallback={<Icon name="arrow-right" size="small" />}>
                <Spinner class="size-3.5" />
              </Show>
              {signingOut() ? t("rail.account.signingOut") : t("rail.account.logout")}
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
