import { type Component, createMemo, Show } from "solid-js"
import { Tag, List, Tooltip } from "@/ui"
import { ModelTooltip } from "./model-tooltip"
import { useComposerText } from "../text"
import { POPULAR_PROVIDERS } from "../harness/provider-catalog"

export type PickerItem = {
  id: string
  name: string
  description?: string
  provider: {
    id: string
    name: string
  }
  latest?: boolean
  connected?: boolean
  free?: boolean
}

function groupConnected(items: readonly PickerItem[]) {
  return items.some((item) => item.connected !== false)
}

function comparePickerProviderGroups(
  a: { items: PickerItem[] },
  b: { items: PickerItem[] },
) {
  const aConnected = groupConnected(a.items)
  const bConnected = groupConnected(b.items)
  if (aConnected !== bConnected) return aConnected ? -1 : 1

  const aProvider = a.items[0]?.provider.id ?? ""
  const bProvider = b.items[0]?.provider.id ?? ""
  const aRank = POPULAR_PROVIDERS.indexOf(aProvider)
  const bRank = POPULAR_PROVIDERS.indexOf(bProvider)
  const aPopular = aRank >= 0
  const bPopular = bRank >= 0
  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  return aRank - bRank
}

export type PickerState = {
  list: () => PickerItem[]
  current: () => PickerItem | undefined
  set: (item: { modelId: string; providerId: string } | undefined, options?: { recent?: boolean }) => void
}

export const ModelList: Component<{
  onSelect: () => void
  model: PickerState
  tooltips?: boolean
}> = (props) => {
  const t = useComposerText()
  const models = createMemo(() => props.model.list())
  const runnableProviders = createMemo(() =>
    new Set(models().filter((m) => m.connected !== false).map((m) => m.provider.id)))

  return (
    <List
      class="composer-model-list flex-1 min-h-0"
      search={{ placeholder: t("dialog.model.search.placeholder"), autofocus: true }}
      emptyMessage={t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={props.model.current()}
      filterKeys={["provider.name", "name", "id", "description"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      groupHeader={(group) => {
        const item = group.items[0]
        if (group.items.every((entry) => entry.connected === undefined)) return item.provider.name
        return (
          <div class="w-full flex items-center justify-between gap-2">
            <span class="truncate">{item.provider.name}</span>
            <Show when={groupConnected(group.items)}>
              <Tag>Configured</Tag>
            </Show>
            <Show when={!groupConnected(group.items)}>
              <Tag>{t("command.provider.connect")}</Tag>
            </Show>
          </div>
        )
      }}
      sortGroupsBy={comparePickerProviderGroups}
      itemWrapper={(item, node) =>
        props.tooltips === false ? (
          node
        ) : (
          <Tooltip
            class="w-full"
            placement="right-start"
            gutter={12}
            openDelay={0}
            value={<ModelTooltip model={item} latest={item.latest} free={item.free === true} />}
          >
            {node}
          </Tooltip>
        )
      }
      onSelect={(x) => {
        props.model.set(x ? { modelId: x.id, providerId: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full min-w-0 flex flex-col items-start gap-y-0.5 text-left text-13-regular">
          <div class="w-full flex items-center gap-x-2">
            <span class="truncate">{i.name}</span>
            <Show when={i.free}>
              <Tag>{t("model.tag.free")}</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>{t("model.tag.latest")}</Tag>
            </Show>
            <Show when={i.connected === false && runnableProviders().has(i.provider.id)}>
              <Tag>{t("command.provider.connect")}</Tag>
            </Show>
          </div>
          <Show when={i.description}>
            <span class="line-clamp-2 text-12-regular text-text-weak">{i.description}</span>
          </Show>
        </div>
      )}
    </List>
  )
}

