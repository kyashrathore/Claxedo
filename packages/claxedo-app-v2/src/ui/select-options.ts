export interface SelectGroup<T> {
  category: string
  options: T[]
}

export const selectItemText = (item: unknown) => (typeof item === "string" ? item : "")

export function groupSelectOptions<T>(options: T[], groupBy?: (item: T) => string): SelectGroup<T>[] {
  if (!groupBy) return [{ category: "", options }]
  const groups = new Map<string, T[]>()
  for (const option of options) {
    const category = groupBy(option)
    const group = groups.get(category)
    if (group) group.push(option)
    else groups.set(category, [option])
  }
  return [...groups.entries()].map(([category, members]) => ({ category, options: members }))
}
