export function basename(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}
