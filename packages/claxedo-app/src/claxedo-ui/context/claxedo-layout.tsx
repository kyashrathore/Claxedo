/**
 * Claxedo Layout Context Extension
 *
 * Extends upstream layout.tsx with rail-specific state for the new UI architecture.
 * This file is Claxedo-specific and does not modify upstream files.
 */

import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@opencode-ai/claxedo-app"
import { createClaxedoLayoutFacade } from "./claxedo-layout/facade"
import { createEmptyTabsState, defaultGroupLayout, type ClaxedoLayoutStore } from "./claxedo-layout/types"

export type {
  TabScope,
  TabType,
  TabItem,
  RailState,
  TopTabsState,
  WorktreeState,
  Pane,
  PaneDir,
  PaneContent,
  PaneLayout,
  MultiPaneTabState,
  GroupLayoutState,
  GroupState,
  SplitState,
  TerminalActionOrigin,
  TerminalAgentStatus,
  TerminalLifecycleState,
} from "./claxedo-layout/types"
export type { LayoutCommand, LayoutDispatch } from "./claxedo-layout/commands"
export type { MultiPaneLeafView } from "./claxedo-layout/selectors"

function migrate(value: unknown) {
  if (!value || typeof value !== "object") return value

  const layout = value as {
    tabs?: unknown
    worktree?: unknown
    groups?: unknown
    split?: unknown
  }

  const emptyGroup = {
    id: "g-default",
    tabs: createEmptyTabsState(),
    worktree: { default: null, pinned: null },
    layout: defaultGroupLayout(),
  }

  const groups = Array.isArray(layout.groups) ? layout.groups : undefined
  if (!groups || groups.length === 0) {
    const flatTabs = layout.tabs
    const flatWorktree = layout.worktree
    if (!flatTabs || typeof flatTabs !== "object") {
      const resultGroups = [emptyGroup]

      return {
        ...layout,
        groups: resultGroups,
        split: { direction: "h", sizes: [1], focusedId: "g-default" },
      }
    }

    const id = "g-initial"
    const worktree =
      flatWorktree && typeof flatWorktree === "object"
        ? (flatWorktree as { default?: string | null; pinned?: string | null })
        : {}
    const resultGroups = [
      {
        id,
        tabs: flatTabs,
        worktree: {
          default: worktree.default ?? null,
          pinned: worktree.pinned ?? null,
        },
        layout: defaultGroupLayout(),
      },
    ]

    return {
      ...layout,
      groups: resultGroups,
      split: { direction: "h", sizes: [1], focusedId: id },
    }
  }

  const next = groups.map((group, index) => {
    if (!group || typeof group !== "object") return { ...emptyGroup, id: `g-${index + 1}` }
    const item = group as {
      id?: string
      tabs?: unknown
      worktree?: unknown
      layout?: unknown
    }
    const tabs = item.tabs && typeof item.tabs === "object" ? item.tabs : createEmptyTabsState()
    const worktree =
      item.worktree && typeof item.worktree === "object"
        ? (item.worktree as { default?: string | null; pinned?: string | null })
        : {}
    return {
      ...item,
      id: item.id ?? `g-${index + 1}`,
      tabs,
      worktree: {
        default: worktree.default ?? null,
        pinned: worktree.pinned ?? null,
      },
      layout: {},
    }
  })

  const rawSplit = layout.split
  const split =
    rawSplit && typeof rawSplit === "object"
      ? (rawSplit as { direction?: "h" | "v"; sizes?: number[]; focusedId?: string })
      : {}
  const fallbackId = next[0]?.id ?? "g-default"
  const focusedId = next.some((group) => group.id === split.focusedId) ? (split.focusedId ?? fallbackId) : fallbackId
  return {
    ...layout,
    groups: next,
    split: {
      direction: split.direction === "v" ? "v" : "h",
      sizes: Array.isArray(split.sizes) && split.sizes.length === next.length ? split.sizes : [1],
      focusedId,
    },
  }
}

export const { use: useClaxedoLayout, provider: ClaxedoLayoutProvider } = createSimpleContext({
  name: "ClaxedoLayout",
  init: () => {
    const target = Persist.global("claxedo.layout.v3", ["claxedo.layout.v2"])

    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore<ClaxedoLayoutStore>({
        rail: {
          collapsed: false,
          hovered: false,
          pinned: true,
          locked: false,
        },
        groups: [
          {
            id: "g-default",
            tabs: createEmptyTabsState(),
            worktree: { default: null, pinned: null },
            layout: defaultGroupLayout(),
          },
        ],
        split: { direction: "h", sizes: [1.0], focusedId: "g-default" },
        enabled: true,
        terminalOwner: {},
        terminalAgentStatus: {},
        terminalAgentSeen: {},
        terminalLifecycle: {},
        workspaceRecency: {},
        worktreeColorMap: {},
        processPane: { toggleVersion: 0, pendingOpen: false, targetDirectory: null, crashedWhileClosed: false, pendingAction: null },
        multiPane: {},
      }),
    )

    // Clear stale pendingOpen from previous sessions — it's a transient
    // signal for within-session workspace switches, not meant to persist.
    setStore("processPane", "pendingOpen", false)
    if (store.processPane.targetDirectory === undefined) setStore("processPane", "targetDirectory", null)

    // Clear stale pending- terminal IDs that survived a reload.
    // During terminal creation, tabs temporarily get a "pending-XXXX" terminalId
    // which is replaced with the real PTY ID after creation. If the page reloads
    // mid-creation, the pending ID persists in localStorage but the ephemeral
    // queue data (queueCreateForTab) is lost, causing a permanent spinner.
    // Remove these tabs before any components mount.
    for (let gi = 0; gi < store.groups.length; gi++) {
      const items = store.groups[gi]?.tabs?.items
      if (!items) continue
      const stale = items.filter(
        (t) => t.type === "terminal" && t.terminalId?.startsWith("pending-"),
      )
      if (stale.length === 0) continue
      const staleIds = new Set(stale.map((t) => t.id))
      setStore("groups", gi, "tabs", "items", (prev) => prev.filter((t) => !staleIds.has(t.id)))
      setStore("groups", gi, "tabs", "order", (prev) => prev.filter((id) => !staleIds.has(id)))
      for (const t of stale) {
        setStore("multiPane", t.id, undefined)
      }
    }

    return createClaxedoLayoutFacade({
      store,
      setStore,
      ready,
    })
  },
})
