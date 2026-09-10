import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeToolAttachment } from "../contracts/agent-runtime-event"
import { text } from "../value"

/**
 * Base64 payload a tool result may carry by value. Across 627 image reads in
 * local transcripts the median encoded read is 86.5 KB and p75 is 175 KB, so
 * 128 KiB admits the typical scratch screenshot and refuses the tail. Only
 * value can show a file outside the workspace root, which the workspace file
 * routes refuse to serve, and every inlined byte is also persisted in the
 * session event store.
 */
export const TOOL_ATTACHMENT_INLINE_MAX_BYTES = 128 * 1024

export function attachmentUrl(mime: string, data: string) {
  return data.startsWith("data:") ? data : `data:${mime};base64,${data}`
}

function segments(value: string) {
  return value.split(/[\\/]/).filter(Boolean)
}

/**
 * The path the workspace file routes accept for `sourcePath`, or undefined when
 * it escapes `root`. Segment comparison rather than prefix matching so that a
 * root and a sibling sharing a prefix (`/w/app` vs `/w/app-2`) stay separate,
 * and so a Windows root matches a forward-slash path from the same harness.
 */
export function workspaceRelativePath(root: string | undefined, sourcePath: string | undefined) {
  if (!root || !sourcePath) return undefined
  const base = segments(root)
  const target = segments(sourcePath)
  if (target.length <= base.length) return undefined
  if (base.some((part, index) => part !== target[index])) return undefined
  const rest = target.slice(base.length)
  if (rest.includes("..")) return undefined
  return rest.join("/")
}

/**
 * The one place a harness turns image bytes into an attachment. A path inside
 * the workspace drops the bytes; anything else keeps them only under the bound.
 */
export function imageAttachment(input: {
  mime: string
  data: string
  filename?: string
  sourcePath?: string
  root?: string
}): RuntimeToolAttachment {
  const named = input.filename ? { filename: input.filename } : {}
  const relative = workspaceRelativePath(input.root, input.sourcePath)
  if (relative && input.sourcePath) {
    return { kind: "workspace-file", mime: input.mime, path: relative, sourcePath: input.sourcePath, ...named }
  }
  const url = attachmentUrl(input.mime, input.data)
  if (url.length <= TOOL_ATTACHMENT_INLINE_MAX_BYTES) {
    return { kind: "inline", mime: input.mime, url, ...named }
  }
  return {
    kind: "unretained",
    mime: input.mime,
    bytes: url.length,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...named,
  }
}

/** The MCP/ACP content-block image, shared by Codex MCP results and Pi tool results. */
export function contentBlockImages(content: unknown): RuntimeToolAttachment[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const block = asRecord(item)
    if (block?.type !== "image") return []
    const mime = text(block.mimeType)
    const data = text(block.data)
    if (!mime || !data) return []
    return [imageAttachment({ mime, data })]
  })
}

/** A bare image url carries no media type, so only a data url can name one. */
export function imageUrlAttachment(url: unknown): RuntimeToolAttachment[] {
  const value = text(url)
  const mime = value ? /^data:([^;,]+)[;,]/.exec(value)?.[1] : undefined
  return value && mime ? [imageAttachment({ mime, data: value })] : []
}
