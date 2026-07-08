export function retainMountedTabsPolicy(input: {
  mounted: string[]
  activeId: string | undefined
  liveIds: Set<string>
  limit?: number
}) {
  const base =
    input.activeId && !input.mounted.includes(input.activeId) ? [...input.mounted, input.activeId] : input.mounted
  const live = base.filter((id) => input.liveIds.has(id))
  if (!input.limit || input.limit < 1 || live.length <= input.limit) return live

  if (input.activeId && live.includes(input.activeId)) {
    const rest = live.filter((id) => id !== input.activeId)
    return [...rest.slice(Math.max(rest.length - (input.limit - 1), 0)), input.activeId]
  }

  return live.slice(Math.max(live.length - input.limit, 0))
}
