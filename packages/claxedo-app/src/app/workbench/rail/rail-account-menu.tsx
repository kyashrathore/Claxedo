import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Show, createContext, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js"

import { useConfigOptional } from "@/app/providers/config"
import { useAuthSession } from "@/platform/auth/auth-session"
import { useAccountPort } from "@/platform/account/account-provider"
import { authDisplayEmail, type AuthDisplayUser } from "@/platform/auth/auth-display"
import { ClaxedoIcon as Icon, type ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import { useLanguage, usePlatform } from "@claxedo/app"

export type RailAccountMenuProps = {
  onDiagnostics?: () => void
  onHelp?: () => void
  onRailLockChange: (locked: boolean) => void
  onSettings?: () => void
  onUsage?: () => void
  utilities?: () => JSX.Element
}

const RailAccountMenuContext = createContext<{ preserveRootOnClose: () => void }>()

export function RailAccountSubmenu(props: {
  children: JSX.Element
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  icon?: ClaxedoIconName
  label: string
}) {
  const context = useContext(RailAccountMenuContext)
  if (!context) throw new Error("RailAccountSubmenu must be rendered inside RailAccountMenu")

  // Kobalte closes a hover-opened submenu the instant the pointer leaves the
  // trigger unless the exit vector lands inside a "safe triangle" aimed at the
  // panel (menu.tsx onItemLeave → isPointerMovingToSubmenu). That wedge's apex
  // is the exit point, so it only holds when the panel sits beside the trigger.
  // Ours is 24rem tall in a rail menu pinned to the viewport bottom, so the
  // popper shifts it upward and a straight sideways exit falls outside the
  // wedge — the panel vanished before the pointer arrived. This is also why the
  // caret appeared to "lock" it: clicking there parked the pointer at the row's
  // right edge, a short enough hop to survive the check. Same bug, not two.
  //
  // So: own the open state and debounce only the close, which makes the wedge
  // geometry irrelevant. Kobalte exposes no closeDelay — the 100ms open and
  // 300ms grace are hardcoded — so the grace has to live here.
  const CLOSE_GRACE_MS = 260
  const [open, setOpen] = createSignal(false)
  // Clicking the trigger pins the panel: pointer grace no longer applies, so
  // you can travel anywhere en route to it. Escape or a click outside releases.
  const [pinned, setPinned] = createSignal(false)
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const cancelClose = () => {
    if (closeTimer === undefined) return
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const openNow = () => {
    cancelClose()
    setOpen(true)
  }
  const closeNow = () => {
    cancelClose()
    setPinned(false)
    setOpen(false)
  }
  const scheduleClose = () => {
    cancelClose()
    if (pinned()) return
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      setOpen(false)
    }, CLOSE_GRACE_MS)
  }
  onCleanup(cancelClose)

  return (
    <DropdownMenu.Sub open={open()} onOpenChange={(next) => (next ? openNow() : scheduleClose())}>
      <DropdownMenu.SubTrigger
        aria-label={props.label}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onClick={() => {
          setPinned(true)
          openNow()
        }}
      >
        <Show when={props.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
        <span class="flex-1">{props.label}</span>
        <Icon name="chevron-right" size="small" class="opacity-30" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          onEscapeKeyDown={() => {
            context.preserveRootOnClose()
            closeNow()
          }}
          // A real click elsewhere is an intent to leave — skip the grace. Note
          // this must NOT hook onFocusOutside: Kobalte's own close path focuses
          // the parent content, which would fire it and defeat the debounce.
          onPointerDownOutside={closeNow}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          class={props.contentClass}
          style={props.contentStyle}
        >
          {props.children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

export function RailAccountMenu(props: RailAccountMenuProps) {
  const auth = useAuthSession()
  const account = useAccountPort()
  const config = useConfigOptional()
  const language = useLanguage()
  const user = createMemo(() => auth.user() as AuthDisplayUser | undefined)
  const accountState = createMemo(() => account.state())
  const signed = createMemo(() => accountState().status === "signed")
  const hostedAccount = createMemo(() => config?.authEnabled === true || config?.loadHostedContributions !== undefined)
  const local = createMemo(() => accountState().status !== "pending" && !signed() && !hostedAccount())
  const label = createMemo(() => {
    const state = accountState()
    if (state.status === "signed") {
      return state.identity.displayName ?? state.identity.email ?? language.t("settings.general.section.account")
    }
    if (state.status === "pending") return language.t("settings.general.section.account")
    return hostedAccount() ? "Sign in" : "Local workspace"
  })
  const image = createMemo(() => signed() && auth.status() === "signed" ? user()?.imageUrl ?? undefined : undefined)
  const authAction = createMemo(() => {
    if (signed()) return "logout" as const
    if (accountState().status !== "pending" && hostedAccount()) return "signin" as const
  })
  const [open, setOpen] = createSignal(false)
  let preserveRootOnClose = false
  const changeOpen = (next: boolean) => {
    if (!next && preserveRootOnClose) return
    if (open() === next) return
    setOpen(next)
    props.onRailLockChange(next)
  }
  const select = (action?: () => void) => {
    action?.()
    changeOpen(false)
  }

  return (
    <DropdownMenu
      open={open()}
      placement="top-start"
      gutter={6}
      // Pin the panel to the trigger's own width — the rail is resizable, so any
      // computed width drifts out of alignment the moment it is dragged.
      sameWidth
      onOpenChange={changeOpen}
    >
      <DropdownMenu.Trigger
        aria-label={label()}
        title={label()}
        class="group flex h-9 w-full items-center gap-2 rounded-md border border-transparent bg-surface-raised-base px-2 text-left text-text-strong outline-none transition-colors hover:bg-surface-raised-base-hover focus-visible:border-border-focus data-[expanded]:bg-surface-raised-base-hover"
        data-testid="rail-account-trigger"
      >
        <Show
          when={signed()}
          fallback={
            <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base" aria-hidden="true">
              <Icon name={local() ? "laptop" : "arrow-right"} size="small" />
            </span>
          }
        >
          <Avatar
            fallback={label()}
            src={image()}
            size="small"
            class="shrink-0"
            aria-hidden="true"
          />
        </Show>
        <span data-slot="rail-account-label" class="min-w-0 flex-1 truncate text-13-medium">
          {label()}
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 rotate-180 text-icon-weak-base opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[expanded]:opacity-100" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-[220]" style={{ "max-width": "calc(100vw - 16px)" }}>
          {/*
            The identity row is the only thing the divider separates — every
            action below it is one continuous list, so it gets exactly one
            separator. The avatar sets this row's height, so the signed-out
            fallback badge matches the Avatar's own 20px box; a larger circle
            here made the header noticeably taller than the rows beneath it.
          */}
          <div class="flex items-center gap-2 px-2 py-1" aria-hidden="true">
            <Show
              when={signed()}
              fallback={
                <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-base">
                  <Icon name={local() ? "laptop" : "arrow-right"} size="small" />
                </span>
              }
            >
              <Avatar fallback={label()} src={image()} size="small" class="shrink-0" />
            </Show>
            <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong" title={label()}>{label()}</span>
          </div>

          <DropdownMenu.Separator />

          <Show when={!!props.utilities}>
            <RailAccountMenuContext.Provider value={{
              preserveRootOnClose: () => {
                preserveRootOnClose = true
                queueMicrotask(() => preserveRootOnClose = false)
              },
            }}>
              {props.utilities?.()}
            </RailAccountMenuContext.Provider>
          </Show>

          <DropdownMenu.Group>
            <Show when={usePlatform().platform === "desktop"}>
              <DropdownMenu.Item onSelect={() => select(props.onDiagnostics)}>
                <Icon name="warning" size="small" />
                <DropdownMenu.ItemLabel>Diagnostics</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </Show>
            <DropdownMenu.Item onSelect={() => select(props.onUsage)}>
              <Icon name="gauge" size="small" />
              <DropdownMenu.ItemLabel>Usage</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => select(props.onSettings)}>
              <Icon name="settings-gear" size="small" />
              <DropdownMenu.ItemLabel>{language.t("sidebar.settings")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => select(props.onHelp)}>
              <Icon name="help" size="small" />
              <DropdownMenu.ItemLabel>{language.t("sidebar.help")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Group>

          <Show when={authAction()}>
            <DropdownMenu.Item
              onSelect={() => {
                if (authAction() === "signin") {
                  void account.signIn()
                  changeOpen(false)
                  return
                }
                void account.signOut()
                changeOpen(false)
              }}
            >
              <Icon name="arrow-right" size="small" />
              <DropdownMenu.ItemLabel>{authAction() === "signin" ? "Sign in" : language.t("settings.general.account.logout.button")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
