export function dependencyGraphHasCycle(
  items: ReadonlyArray<Readonly<{ id: string; dependencyIds: readonly string[] }>>,
) {
  const dependencies = new Map(items.map((item) => [item.id, item.dependencyIds]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = (dependencies.get(id) ?? []).some(visit)
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }

  return items.some((item) => visit(item.id))
}
