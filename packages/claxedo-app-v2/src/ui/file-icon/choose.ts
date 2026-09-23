import extensions from "./extensions.json"
import fileNames from "./file-names.json"
import folderNames from "./folder-names.json"
import names from "./names.json"

export type FileIconName = string

export type FileNode = { path: string; type: "file" | "directory" }

const known = new Set<string>(names)
const byFileName: Record<string, string> = fileNames
const byExtension: Record<string, string> = extensions
const byFolderName: Record<string, string> = folderNames

const defaults = { file: "Document", folder: "Folder", folderOpen: "FolderOpen" }

const basename = (path: string) => path.split("\\").join("/").split("/").filter(Boolean).pop() ?? ""

const openVariant = (icon: string) => {
  if (!icon.startsWith("Folder")) return icon
  const open = icon.endsWith("_light") ? icon.replace("_light", "Open_light") : icon.endsWith("Open") ? icon : `${icon}Open`
  return known.has(open) ? open : icon
}

const folderIcon = (name: string, expanded: boolean) => {
  for (const candidate of [name, `.${name}`, `_${name}`, `__${name}__`]) {
    const icon = byFolderName[candidate]
    if (icon) return expanded ? openVariant(icon) : icon
  }
  return expanded ? defaults.folderOpen : defaults.folder
}

const suffixes = (name: string) => {
  const out = new Set<string>([name])
  for (let index = 0; index < name.length; index++) {
    if (name[index] === "." && index + 1 < name.length) out.add(name.slice(index + 1))
  }
  return Array.from(out).sort((a, b) => b.length - a.length)
}

export function chooseFileIcon(node: FileNode, expanded = false): FileIconName {
  const name = basename(node.path).toLowerCase()
  if (node.type === "directory") return folderIcon(name, expanded)
  const byName = byFileName[name]
  if (byName) return byName
  for (const suffix of suffixes(name)) {
    const icon = byExtension[suffix]
    if (icon) return icon
  }
  return defaults.file
}
