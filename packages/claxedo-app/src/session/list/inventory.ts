import { machine, type Machine } from "@/lib/machine"
import { type ServerEvent, type SessionLocation, type SessionActivityFilter } from "@/server"
import type { InventoryServer } from "./inventory-pages"
import { inventoryRows } from "./inventory-rows"
import { EMPTY_INVENTORY, inventoryTransition, type InventoryWindow } from "./inventory-model"
import { createInventoryReads, type InventoryQueryKey, type InventoryWindows } from "./inventory-reads"
import type { ListEvent, ListState } from "./model"
import { activityFilterTransition, type ActivityFilterEvent, type ActivityFilterState } from "./activity-filter"

export type SessionInventory = {
  readonly filter: () => SessionActivityFilter
  readonly cycleFilter: () => Promise<void>
  readonly resetFilter: () => Promise<void>
  readonly rows: () => readonly SessionLocation[]
  readonly window: () => InventoryWindow
  readonly load: () => Promise<void>
  readonly more: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly sharedRows: () => readonly SessionLocation[]
  readonly sharedWindow: () => InventoryWindow
  readonly loadShared: () => Promise<void>
  readonly moreShared: () => Promise<void>
}

export function createSessionInventory(server: InventoryServer, list: Machine<ListState, ListEvent>): SessionInventory & { apply(event: ServerEvent): void } {
  const windows: InventoryWindows = { active: machine(EMPTY_INVENTORY, inventoryTransition), shared: machine(EMPTY_INVENTORY, inventoryTransition) }
  const filter = machine<ActivityFilterState, ActivityFilterEvent>({ kind: "all" }, activityFilterTransition)
  const activity = () => filter.state().kind
  const loaded = new Set<InventoryQueryKey>()
  const { read } = createInventoryReads(server, list, windows, activity)
  const reload = async () => { await Promise.all([...loaded].map((key) => read(key))) }
  const load = async (keys: readonly InventoryQueryKey[]) => {
    for (const key of keys) loaded.add(key)
    await Promise.all(keys.map((key) => read(key)))
  }
  const changeFilter = async (event: ActivityFilterEvent) => {
    const previous = activity()
    filter.send(event)
    if (previous === activity()) return
    windows.active.send({ type: "filterChanged" })
    await load(["active"])
  }
  return {
    filter: activity,
    cycleFilter: () => changeFilter({ type: "cycled" }),
    resetFilter: () => changeFilter({ type: "reset" }),
    rows: () => inventoryRows(list.state().entries, windows.active.state(), activity()),
    window: () => windows.active.state(),
    more: () => read("active", true),
    load: () => load(["active"]),
    sharedRows: () => inventoryRows(list.state().entries, windows.shared.state()),
    sharedWindow: () => windows.shared.state(),
    loadShared: () => load(["shared"]),
    moreShared: () => read("shared", true),
    reload,
    apply: (event) => {
      if (["sessionsChanged", "sessionRemoved", "sessionUpserted", "statusChanged", "backgroundWorkChanged", "attentionChanged", "readerChanged", "streamGap", "placementsChanged", "cloudWorkspaceChanged"].includes(event.type)) void reload()
    },
  }
}
