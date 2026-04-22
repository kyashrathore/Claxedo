/**
 * Claxedo override of `@/components/prompt-input/build-request-parts`.
 *
 * The override calls upstream's implementation first, then APPENDS synthetic
 * parts for each pending `PageElementComment` in
 * `useBrowserComments().pending(sessionID)` — one text part with
 * `metadata.opencodeComment = { origin: "browser", selector, pageUrl, ... }`
 * plus one image part per screenshot.
 *
 * No upstream input is rewritten. For callers where the browser feature is
 * unused, `pending()` returns `[]` and the output is byte-identical to the
 * upstream function.
 *
 * Claxedo-owned data plane:
 * - The override imports from the claxedo browser store only.
 * - Upstream's `ContextItem` union is NOT widened; page-element comments
 *   never enter `prompt.context.items`.
 *
 * Upstream module is imported via a direct relative path
 * (`../../../../../app/src/...`) so the regex override alias for
 * `@/components/prompt-input/build-request-parts` does not resolve back to
 * this file and create a cycle.
 */

import type { Part } from "@opencode-ai/sdk/v2/client"
import { buildRequestParts as buildRequestPartsUpstream } from "../../../../../app/src/components/prompt-input/build-request-parts"
import { Identifier } from "@/utils/id"
import { useBrowserComments, type PageElementComment } from "../../../browser/store/browser-comments"

// Re-derive the part shape — upstream does not export the local alias.
type PromptRequestPart = ReturnType<typeof buildRequestPartsUpstream>["requestParts"][number]

type BuildRequestPartsInput = Parameters<typeof buildRequestPartsUpstream>[0]
type BuildRequestPartsResult = ReturnType<typeof buildRequestPartsUpstream>

const optimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

function inferMime(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? "image/png"
}

function browserCommentParts(comments: PageElementComment[]): PromptRequestPart[] {
  const parts: PromptRequestPart[] = []
  for (const comment of comments) {
    parts.push({
      id: Identifier.ascending("part"),
      type: "text",
      text: comment.noteText,
      synthetic: true,
      metadata: {
        opencodeComment: {
          origin: "browser",
          selector: comment.selector,
          pageUrl: comment.pageUrl,
          boundingBox: comment.boundingBox,
          outerHTML: comment.outerHTML,
          comment: comment.comment,
        },
      },
    } as PromptRequestPart)
    if (comment.screenshotDataUrl) {
      parts.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: inferMime(comment.screenshotDataUrl),
        url: comment.screenshotDataUrl,
        filename: `element-${comment.id}.png`,
      } as PromptRequestPart)
    }
  }
  return parts
}

function readPending(sessionID: string | undefined): PageElementComment[] {
  if (!sessionID) return []
  try {
    const comments = useBrowserComments()
    return comments.pending(sessionID)
  } catch {
    // Provider not mounted (e.g. unit tests, or non-browser contexts that
    // call build-request-parts before the claxedo app shell has wired up
    // providers). Return empty — upstream path stays byte-identical.
    return []
  }
}

export function buildRequestParts(input: BuildRequestPartsInput): BuildRequestPartsResult {
  const upstream = buildRequestPartsUpstream(input)

  const pending = readPending(input.sessionID)
  if (pending.length === 0) return upstream

  const extra = browserCommentParts(pending)
  const requestParts = [...upstream.requestParts, ...extra]
  const optimisticParts = [
    ...upstream.optimisticParts,
    ...extra.map((part) => optimisticPart(part, input.sessionID, input.messageID)),
  ]
  return { requestParts, optimisticParts }
}

export type { BuildRequestPartsInput, BuildRequestPartsResult }
