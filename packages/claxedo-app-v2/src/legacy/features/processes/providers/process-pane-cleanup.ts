export function staleProcessTerminalIds(processOwned: Iterable<string>, current: ReadonlySet<string>) {
  return new Set([...processOwned].filter((id) => !current.has(id)))
}
