export interface DecisionReadinessWorkItem {
  readonly id: string
  readonly dependencyIds: readonly string[]
}

export interface PendingDecisionReference {
  readonly id: string
  readonly affectedWorkItemIds: readonly string[]
}

export interface WorkItemDecisionReadiness {
  readonly workItemId: string
  readonly ready: boolean
  readonly blockingDecisionIds: readonly string[]
}

export function evaluateDecisionReadiness(input: {
  readonly workItems: readonly DecisionReadinessWorkItem[]
  readonly pendingDecisions: readonly PendingDecisionReference[]
}): readonly WorkItemDecisionReadiness[] {
  const blockers = new Map(input.workItems.map((item) => [item.id, new Set<string>()]))
  input.pendingDecisions.forEach((decision) => {
    decision.affectedWorkItemIds.forEach((id) => blockers.get(id)?.add(decision.id))
  })

  const propagate = () => input.workItems.reduce((changed, item) => {
    const inherited = item.dependencyIds.flatMap((id) => [...(blockers.get(id) ?? [])])
    const target = blockers.get(item.id)!
    const additions = inherited.filter((id) => !target.has(id))
    additions.forEach((id) => target.add(id))
    return changed || additions.length > 0
  }, false)
  while (propagate()) {}

  return input.workItems.map((item) => {
    const blockingDecisionIds = [...blockers.get(item.id)!].sort()
    return { workItemId: item.id, ready: blockingDecisionIds.length === 0, blockingDecisionIds }
  })
}
