import { panes as paneInfos } from "./pane-intent"
import type { PaneLayout, TabItem } from "./types"

export type TabContextPane = {
  leafId: string
  name: string
  type: TabItem["type"]
  directory?: string
  title: string | undefined
  sessionId: string | undefined
  terminalId: string | undefined
  pageId: string | undefined
  filePath: string | undefined
  intent:
    | {
        name?: string
        role?: string
        refs?: string[]
        defaults?: {
          agent?: string
          system?: string
        }
        meta?: Record<string, string>
      }
    | undefined
  meta: Record<string, string>
}

export type TabContextSnapshot = {
  tabId: string
  groupId: string
  tabType: TabItem["type"]
  scope: TabItem["scope"]
  directory?: string
  title: string
  sessionId: string | undefined
  reviewMode: TabItem["reviewMode"] | undefined
  reviewFromRef: string | undefined
  reviewToRef: string | undefined
  pageId: string | undefined
  terminalId: string | undefined
  activeLeafId: string | undefined
  focusedLeafId: string | undefined
  terminalIds: string[]
  panes: TabContextPane[]
  updatedAt: number
}

type TabContextPayload = {
  tabId: string
  groupId?: string
  tabType: string
  scope?: string
  directory?: string
  title?: string
  sessionId?: string
  reviewMode?: string
  reviewFromRef?: string
  reviewToRef?: string
  pageId?: string
  terminalId?: string
  activeLeafId?: string
  focusedLeafId?: string
  terminalIds?: string[]
  panes?: Array<{
    leafId: string
    name: string
    type: string
    directory?: string
    title?: string
    sessionId?: string
    terminalId?: string
    pageId?: string
    filePath?: string
    intent?: {
      name?: string
      role?: string
      refs?: string[]
      defaults?: {
        agent?: string
        system?: string
        prompt?: string
      }
      meta?: Record<string, string>
    }
    meta?: Record<string, string>
  }>
  updatedAt?: number
}

function obj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function list(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function meta(value: unknown) {
  if (!obj(value)) return undefined
  const next = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (!Object.keys(next).length) return undefined
  return next
}

function intent(value: unknown) {
  if (!obj(value)) return undefined
  const defaults = obj(value.defaults)
    ? {
        agent: text(value.defaults.agent),
        system: text(value.defaults.system),
        prompt: text(value.defaults.prompt),
      }
    : undefined
  const next = {
    name: text(value.name),
    role: text(value.role),
    refs: list(value.refs),
    defaults: defaults && Object.values(defaults).some(Boolean) ? defaults : undefined,
    meta: meta(value.meta),
  }
  if (Object.values(next).some(Boolean)) return next
  return undefined
}

function pane(value: unknown) {
  if (!obj(value)) return undefined
  const leafId = text(value.leafId)
  const name = text(value.name)
  const type = text(value.type)
  if (!leafId || !name || !type) return undefined
  return {
    leafId,
    name,
    type,
    directory: text(value.directory),
    title: text(value.title),
    sessionId: text(value.sessionId),
    terminalId: text(value.terminalId),
    pageId: text(value.pageId),
    filePath: text(value.filePath),
    intent: intent(value.intent),
    meta: meta(value.meta),
  }
}

export function packTabContextSnapshot(value: TabContextSnapshot | undefined): TabContextPayload | undefined {
  if (!value) return
  const tabId = text(value.tabId)
  const tabType = text(value.tabType)
  if (!tabId || !tabType) return
  const panes = Array.isArray(value.panes) ? value.panes.map(pane).filter((item): item is NonNullable<ReturnType<typeof pane>> => !!item) : undefined
  const terminalIds = list(value.terminalIds)
  return {
    tabId,
    groupId: text(value.groupId),
    tabType,
    scope: text(value.scope),
    directory: text(value.directory),
    title: text(value.title),
    sessionId: text(value.sessionId),
    reviewMode: text(value.reviewMode),
    reviewFromRef: text(value.reviewFromRef),
    reviewToRef: text(value.reviewToRef),
    pageId: text(value.pageId),
    terminalId: text(value.terminalId),
    activeLeafId: text(value.activeLeafId),
    focusedLeafId: text(value.focusedLeafId),
    terminalIds: terminalIds?.length ? terminalIds : undefined,
    panes: panes?.length ? panes : undefined,
    updatedAt: num(value.updatedAt),
  }
}

function origin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

export function buildTabContextSnapshot(input: { groupId: string; tab: TabItem; layout: PaneLayout | undefined }) {
  const panes = paneInfos(input.layout).map((pane) => ({
    leafId: pane.leafId,
    name: pane.name,
    type: pane.content.type,
    directory: pane.content.directory,
    title: pane.content.title,
    sessionId: pane.content.sessionId,
    terminalId: pane.content.terminalId,
    pageId: pane.content.pageId,
    filePath: pane.content.filePath,
    intent: pane.content.intent,
    meta: pane.meta,
  }))

  const terminalIds = [
    ...(input.tab.terminalId ? [input.tab.terminalId] : []),
    ...panes.map((pane) => pane.terminalId).filter((id): id is string => !!id),
  ]

  return {
    tabId: input.tab.id,
    groupId: input.groupId,
    tabType: input.tab.type,
    scope: input.tab.scope,
    directory: input.tab.directory,
    title: input.tab.title,
    sessionId: input.tab.sessionId,
    reviewMode: input.tab.reviewMode,
    reviewFromRef: input.tab.reviewFromRef,
    reviewToRef: input.tab.reviewToRef,
    pageId: input.tab.pageId,
    terminalId: input.tab.terminalId,
    activeLeafId: input.layout?.focus,
    focusedLeafId: input.layout?.focus,
    terminalIds: [...new Set(terminalIds)],
    panes,
    updatedAt: Date.now(),
  } satisfies TabContextSnapshot
}

export function createTabContextSyncAdapter(input: { sdkUrl: () => string; request?: typeof fetch }) {
  const request = input.request ?? fetch
  let last = ""

  const push = (snapshot: TabContextSnapshot | undefined) => {
    const payload = packTabContextSnapshot(snapshot)
    if (!payload) return

    const key = JSON.stringify({
      ...payload,
      updatedAt: 0,
    })
    if (key === last) return
    last = key

    const base = origin(input.sdkUrl())
    if (!base) return

    void request(`${base}/api/claxedo/hook/tab-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch(() => {})
  }

  return {
    push,
  }
}
