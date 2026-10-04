export function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}
