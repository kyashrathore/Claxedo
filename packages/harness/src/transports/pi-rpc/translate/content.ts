import { asArray, asRecord } from "@claxedo/helpers/guards"

export function piContentText(content: unknown): string {
  if (typeof content === "string") return content
  return asArray(content).flatMap((item) => {
    const block = asRecord(item)
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : []
  }).join("\n")
}
