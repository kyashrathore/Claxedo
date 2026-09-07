import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { useLanguage } from "@/platform/i18n/provider"
import { Persist, persisted } from "@/platform/persistence/persist"
import { fileManagerTarget, openInTargets, type OpenInIcon, type OpenInOS } from "./open-in-targets"

/** A stuck `openPath` would otherwise leave the control disabled forever. */
const OPEN_REQUEST_TIMEOUT_MS = 10_000

type Option = { id: string; label: string; icon: OpenInIcon; openWith?: string }

export function SessionOpenInControl(props: {
  /** The workspace location the menu opens and Copy path writes. */
  path: string
  os: OpenInOS
  /** Absent on web and on a remote server: the control then offers only Copy path. */
  openPath?: (path: string, app?: string) => Promise<void>
  checkAppExists?: (appName: string) => Promise<boolean>
}) {
  const language = useLanguage()
  const fileManager = createMemo(() => fileManagerTarget(props.os))
  const targets = createMemo(() => openInTargets(props.os))

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" }))
  const [menu, setMenu] = createStore({ open: false })
  const [request, setRequest] = createStore({ app: undefined as string | undefined })
  let requestID = 0
  let requestTimeout: ReturnType<typeof setTimeout> | undefined

  const [installed] = createResource(
    () => (props.checkAppExists ? targets() : undefined),
    async (list) => {
      const check = props.checkAppExists
      const found: Record<string, boolean> = {}
      if (!check) return found
      await Promise.all(
        list.map((target) =>
          Promise.resolve(check(target.openWith))
            .catch(() => false)
            .then((value) => {
              found[target.id] = value
            }),
        ),
      )
      return found
    },
  )

  const options = createMemo<Option[]>(() => [
    { id: "finder", label: language.t(fileManager().labelKey), icon: fileManager().icon },
    ...targets()
      .filter((target) => installed()?.[target.id])
      .map((target) => ({
        id: target.id,
        label: language.t(target.labelKey),
        icon: target.icon,
        openWith: target.openWith,
      })),
  ])

  const current = createMemo<Option>(
    () =>
      options().find((option) => option.id === prefs.app) ??
      options()[0] ?? { id: "finder", label: language.t(fileManager().labelKey), icon: fileManager().icon },
  )
  const opening = createMemo(() => request.app !== undefined)

  const clearRequest = (id: number) => {
    if (id !== requestID) return
    if (requestTimeout) {
      clearTimeout(requestTimeout)
      requestTimeout = undefined
    }
    setRequest("app", undefined)
  }

  onCleanup(() => {
    if (requestTimeout) clearTimeout(requestTimeout)
  })

  const reportFailure = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  const open = (id: string) => {
    const openPath = props.openPath
    if (opening() || !openPath || !props.path) return
    const option = options().find((item) => item.id === id)
    if (!option) return
    const nextID = ++requestID
    setRequest("app", id)
    if (requestTimeout) clearTimeout(requestTimeout)
    requestTimeout = setTimeout(() => clearRequest(nextID), OPEN_REQUEST_TIMEOUT_MS)
    openPath(props.path, option.openWith)
      .catch(reportFailure)
      .finally(() => clearRequest(nextID))
  }

  const copyPath = () => {
    if (!props.path) return
    navigator.clipboard
      .writeText(props.path)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: props.path,
        })
      })
      .catch(reportFailure)
  }

  return (
    <Show
      when={props.openPath}
      fallback={
        <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-base overflow-hidden">
          <Button
            variant="ghost"
            class="rounded-none h-full py-0 pr-3 pl-0.5 gap-1.5 border-none shadow-none"
            onClick={copyPath}
            aria-label={language.t("session.header.open.copyPath")}
          >
            <Icon name="copy" size="small" class="text-icon-base" />
            <span class="text-12-regular text-text-strong">{language.t("session.header.open.copyPath")}</span>
          </Button>
        </div>
      }
    >
      <div
        data-testid="session-open-in"
        class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-base overflow-hidden"
      >
        <Button
          variant="ghost"
          class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
          classList={{ "bg-surface-raised-base-active": opening() }}
          onClick={() => open(current().id)}
          disabled={opening()}
          aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
        >
          <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
            <Show when={opening()} fallback={<AppIcon id={current().icon} />}>
              <Spinner class="size-3.5" />
            </Show>
          </div>
        </Button>
        <DropdownMenu
          gutter={4}
          placement="bottom-end"
          open={menu.open}
          onOpenChange={(open: boolean) => setMenu("open", open)}
        >
          <DropdownMenu.Trigger
            as={IconButton}
            icon="chevron-down"
            variant="ghost"
            disabled={opening()}
            class="rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default"
            classList={{ "bg-surface-raised-base-active": opening() }}
            aria-label={language.t("session.header.open.menu")}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel class="!px-1 !py-1">
                  {language.t("session.header.openIn")}
                </DropdownMenu.GroupLabel>
                <DropdownMenu.RadioGroup
                  class="mt-1"
                  value={current().id}
                  onChange={(value: unknown) => {
                    if (typeof value !== "string") return
                    if (!options().some((option) => option.id === value)) return
                    setPrefs("app", value)
                  }}
                >
                  <For each={options()}>
                    {(option) => (
                      <DropdownMenu.RadioItem
                        value={option.id}
                        disabled={opening()}
                        onSelect={() => {
                          setMenu("open", false)
                          open(option.id)
                        }}
                      >
                        <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                          <AppIcon id={option.icon} />
                        </div>
                        <DropdownMenu.ItemLabel>{option.label}</DropdownMenu.ItemLabel>
                        <DropdownMenu.ItemIndicator>
                          <Icon name="check-small" size="small" class="text-icon-weak-base" />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onSelect={() => {
                  setMenu("open", false)
                  copyPath()
                }}
              >
                <div class="flex size-5 shrink-0 items-center justify-center">
                  <Icon name="copy" size="small" class="text-icon-weak-base" />
                </div>
                <DropdownMenu.ItemLabel>{language.t("session.header.open.copyPath")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
    </Show>
  )
}
