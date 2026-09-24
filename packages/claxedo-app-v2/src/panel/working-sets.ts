import { REVIEW_TAB, REVIEW_TAB_ID, type ReviewWorkspaceTab } from "./workspace-tabs"

export type WorkingSet = {
  readonly tabs: readonly ReviewWorkspaceTab[]
  readonly activeTabId: string
}

export type WorkingSets = {
  readonly entries: Readonly<Record<string, WorkingSet>>
  readonly order: readonly string[]
}

export const WORKING_SET_CAP = 32

export const emptyWorkingSet: WorkingSet = { tabs: [REVIEW_TAB], activeTabId: REVIEW_TAB_ID }

export const emptyWorkingSets: WorkingSets = { entries: {}, order: [] }

export function withWorkingSet(sets: WorkingSets, key: string, set: WorkingSet): WorkingSets {
  const order = [...sets.order.filter((item) => item !== key), key]
  const kept = order.slice(-WORKING_SET_CAP)
  const entries: Record<string, WorkingSet> = {}
  for (const item of kept) entries[item] = item === key ? set : sets.entries[item]!
  return { entries, order: kept }
}
