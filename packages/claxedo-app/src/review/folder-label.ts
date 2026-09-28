export type FolderLabel = { readonly cut: string; readonly whole: string }

export function folderLabel(folder: string): FolderLabel | undefined {
  if (!folder) return undefined
  const split = folder.lastIndexOf("/") + 1
  return { cut: folder.slice(0, split), whole: folder.slice(split) }
}
