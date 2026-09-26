import { bundledLanguagesInfo } from "shiki"
import { getFilename } from "@/ui/utils"
import type { AgentFilePart } from "@claxedo/agent-runtime-contract"

export function attached(part: AgentFilePart) {
  return part.url.startsWith("data:")
}

export function inline(part: AgentFilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: AgentFilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}

const LANGUAGE_NAMES = new Map<string, string>(
  bundledLanguagesInfo.flatMap((info) =>
    [info.id, ...(info.aliases ?? [])].map((alias) => [alias, info.name] as [string, string]),
  ),
)

export function typeLabel(filename: string, mime: string) {
  if (mime === "application/pdf") return "PDF"
  const base = getFilename(filename)
  const idx = base.lastIndexOf(".")
  const suffix = idx <= 0 ? "" : base.slice(idx + 1).toLowerCase()
  if (!suffix) return "File"
  return LANGUAGE_NAMES.get(suffix) ?? suffix.toUpperCase()
}
