// Claxedo keeps the upstream model picker UI while routing provider actions through Claxedo-owned provider dialogs.
import { Popover as Kobalte } from "@kobalte/core/popover"
import { type Component, type ComponentProps, createMemo, type JSX, Show, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/platform/query/provider-list"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "@/features/session/ui/model/model-tooltip"
import { useLanguage } from "@/platform/i18n/provider"
import { loadManageModelsDialog, loadSelectProviderDialog } from "@/features/session/app-ports"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

export type PickerItem = {
  id: string
  name: string
  /** Harness-supplied detail line. Display names are short marketing labels
   * ("Sonnet", "Opus"), so this is the only place the version and context
   * window appear — e.g. "Opus 4.8 with 1M context · $5/$25 per Mtok". */
  description?: string
  provider: {
    id: string
    name: string
  }
  cost?: { input: number; output?: number }
  latest?: boolean
  connected?: boolean
}

export function comparePickerProviderGroups(
  a: { items: PickerItem[] },
  b: { items: PickerItem[] },
) {
  const aConnected = a.items[0]?.connected !== false
  const bConnected = b.items[0]?.connected !== false
  if (aConnected !== bConnected) return aConnected ? -1 : 1

  const aProvider = a.items[0]?.provider.id ?? ""
  const bProvider = b.items[0]?.provider.id ?? ""
  const aRank = popularProviders.indexOf(aProvider)
  const bRank = popularProviders.indexOf(bProvider)
  const aPopular = aRank >= 0
  const bPopular = bRank >= 0
  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  return aRank - bRank
}

export type PickerState = {
  list: () => PickerItem[]
  current: () => PickerItem | undefined
  visible: (item: { modelID: string; providerID: string }) => boolean
  set: (item: { modelID: string; providerID: string } | undefined, options?: { recent?: boolean }) => void
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model: PickerState
  tooltips?: boolean
}> = (props) => {
  const language = useLanguage()

  const models = createMemo(() =>
    props.model
      .list()
      .filter((m) => props.model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={props.model.current()}
      filterKeys={["provider.name", "name", "id", "description"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      groupHeader={(group) => {
        const item = group.items[0]
        if (item.connected === undefined) return item.provider.name
        return (
          <div class="w-full flex items-center justify-between gap-2">
            <span class="truncate">{item.provider.name}</span>
            <Show when={item.connected === true}>
              <Tag>Configured</Tag>
            </Show>
            <Show when={item.connected === false}>
              <Tag>{language.t("command.provider.connect")}</Tag>
            </Show>
          </div>
        )
      }}
      sortGroupsBy={comparePickerProviderGroups}
      itemWrapper={(item, node) => props.tooltips === false
        ? node
        : (
          <Tooltip
            class="w-full"
            placement="right-start"
            gutter={12}
            openDelay={0}
            // as-any: picker item is structurally the tooltip model, but the wrapper generic erases it.
            value={<ModelTooltip model={item as unknown as Parameters<typeof ModelTooltip>[0]["model"]} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
          >
            {node}
          </Tooltip>
        )}
      onSelect={(x) => {
        props.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full min-w-0 flex flex-col items-start gap-y-0.5 text-left text-13-regular">
          <div class="w-full flex items-center gap-x-2">
            <span class="truncate">{i.name}</span>
            <Show when={isFree(i.provider.id, i.cost)}>
              <Tag>{language.t("model.tag.free")}</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>{language.t("model.tag.latest")}</Tag>
            </Show>
          </div>
          {/* Display names are short labels ("Sonnet", "Opus"); the version and
              context window live only here, so give it its own line rather than
              truncating it away next to the name. */}
          <Show when={i.description}>
            <span class="line-clamp-2 text-12-regular text-text-weak">{i.description}</span>
          </Show>
        </div>
      )}
    </List>
  )
}

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
  connectHarness?: string
  /** Extra class for the popover surface. The composer passes its shared
   * dropdown class so this picker matches the other menus on the dock instead
   * of opening at its own width and row rhythm. */
  contentClass?: string
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void loadManageModelsDialog().then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void loadSelectProviderDialog().then((x) => {
      dialog.show(() => <x.DialogSelectProvider harness={props.connectHarness} />)
    })
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
          // `w-72`/`p-2` only apply when no caller has taken over sizing: a
          // Tailwind utility lives in @layer utilities and would beat the
          // caller's own width/padding rules.
          class={`theme-overlay-surface codex-model-picker ${props.contentClass ? "" : "w-72 p-2"} h-80 flex flex-col rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden ${props.contentClass ?? ""}`}
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

export const DialogSelectModel: Component<{ provider?: string; model: PickerState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const provider = () => {
    void loadSelectProviderDialog().then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void loadManageModelsDialog().then((x) => {
      dialog.show(() => <x.DialogManageModels />)
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
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
