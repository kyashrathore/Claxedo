// Claxedo keeps the upstream model picker UI while routing provider setup through Settings → Providers.
import { Popover as Kobalte } from "@kobalte/core/popover"
import { type Component, type ComponentProps, type JSX, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/platform/i18n/provider"
import { loadManageModelsDialog } from "@/features/session/app-ports"
import { useNavigate } from "@solidjs/router"
import { settingsRoute } from "@/platform/settings/route"
import type { Surface } from "@/platform/telemetry/analytics"
import { ModelList, type PickerState } from "./model-list"

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model: PickerState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
  actions?: boolean
  tooltips?: boolean
  /** Extra class for the popover surface. The composer passes its shared
   * dropdown class so this picker matches the other menus on the dock instead
   * of opening at its own width and row rhythm. */
  contentClass?: string
  /** `model_selected` telemetry surface. Defaults to "composer" — every current
   * caller of this popover lives on the composer dock. */
  surface?: Surface
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const navigate = useNavigate()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void loadManageModelsDialog().then((x) => {
      void dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    navigate(settingsRoute("models"))
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          data-surface="overlay"
          data-overlay-shell="menu"
          // `w-72`/`p-2` only apply when no caller has taken over sizing: a
          // Tailwind utility lives in @layer utilities and would beat the
          // caller's own width/padding rules.
          class={`codex-model-picker ${props.contentClass ? "" : "w-72 p-2"} h-80 flex flex-col bg-surface-raised-stronger-non-alpha z-50 outline-none overflow-hidden ${props.contentClass ?? ""}`}
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            tooltips={props.tooltips}
            surface={props.surface}
            onSelect={() => close("select")}
            class="p-1"
            action={props.actions === false ? undefined : (
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="small"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="small"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            )}
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model: PickerState; surface?: Surface }> = (props) => {
  const dialog = useDialog()
  const navigate = useNavigate()
  const language = useLanguage()

  const provider = () => {
    navigate(settingsRoute("models"))
  }

  const manage = () => {
    void loadManageModelsDialog().then((x) => {
      void dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} surface={props.surface} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
