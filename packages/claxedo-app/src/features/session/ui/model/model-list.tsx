import { type Component, createMemo, type JSX, onMount, Show } from "solid-js"
import { popularProviders } from "@/platform/query/provider-list"
import { Tag } from "@opencode-ai/ui/tag"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "@/features/session/ui/model/model-tooltip"
import { useLanguage } from "@/platform/i18n/provider"
import { capture as phCapture, identityProps, type Surface } from "@/platform/telemetry/analytics"


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
  // Catalog-backed detail the hover card reads. Declared here because the picker
  // items ARE the catalog models (`useProviders().list()` spreads them through);
  // leaving them off meant every tooltip render asserted the item into a
  // different shape, which is also how a picker item WITHOUT them typechecked.
  limit?: { context: number }
  capabilities?: { reasoning: boolean; input: Record<string, boolean> }
  modalities?: { input: string[] }
  reasoning?: boolean
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
  visible: (
    item: { modelID: string; providerID: string },
    /** Catalog-scoped defaults when the picker is rendering a harness-specific catalog. */
    defaults?: Record<string, string>,
  ) => boolean
  set: (item: { modelID: string; providerID: string } | undefined, options?: { recent?: boolean }) => void
  /**
   * PRODUCT DECISION (provider catalog as an index): the app boots on the
   * provider INDEX — one default model per connected provider — and fetches
   * the full model set lazily. `ModelList` calls this when it mounts, i.e.
   * exactly when a picker opens, so the list populates in place instead of
   * silently staying defaults-only. Harness-row pickers, whose lists are
   * already complete, leave it unset.
   */
  hydrate?: () => void
}

/**
 * Exported so the composer's merged harness→model picker can host the REAL
 * list inside its own disclosure instead of reimplementing it. Search,
 * provider grouping, connected/free/latest tags, tooltips and the
 * `model_selected` commit point all live here and must not fork.
 */
export const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model: PickerState
  tooltips?: boolean
  /** Where this picker was opened from, for `model_selected` telemetry. Every
   * caller of `ModelSelectorPopover`/`DialogSelectModel` shares this one commit
   * point, so the surface travels as a prop rather than being guessed here. */
  surface?: Surface
}> = (props) => {
  const language = useLanguage()

  // The list mounts when a picker opens (popover/dialog content is lazy), so
  // this is the "picker actually opened" moment the index contract defers the
  // full catalog fetch to. See `PickerState.hydrate`.
  onMount(() => props.model.hydrate?.())

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
            <Show when={item.connected}>
              <Tag>Configured</Tag>
            </Show>
            <Show when={!item.connected}>
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
            value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
          >
            {node}
          </Tooltip>
        )}
      onSelect={(x) => {
        props.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        // Only a real pick, never the list's own clear/deselect call.
        if (x) {
          phCapture("model_selected", {
            ...identityProps(),
            surface: props.surface ?? "composer",
            provider_id: x.provider.id,
            model_id: x.id,
          })
        }
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full min-w-0 flex flex-col items-start gap-y-0.5 text-left text-13-regular">
          <div class="w-full flex items-center gap-x-2">
            {/* The row's own name, separate from the description line below it:
                a display name is a short label ("Sonnet") and only this slot
                carries it alone. */}
            <span data-slot="list-item-name" class="truncate">{i.name}</span>
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

