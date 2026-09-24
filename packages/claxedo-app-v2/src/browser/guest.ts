import { asFiniteNumber, isRecord } from "@claxedo/helpers/guards"
import type { BrowserBox } from "./model"

export const GUEST_PICK_CHANNEL = "claxedo-browser-pick"
export const GUEST_SUBMIT_CHANNEL = "claxedo-browser-comment-submit"
export const GUEST_PICKER_MODE_CHANNEL = "claxedo-picker:set-mode"
export const GUEST_THEME_CHANNEL = "claxedo-theme:tokens"

export type GuestPickPayload = {
  readonly selector: string
  readonly frameUrl?: string
  readonly tagName?: string
  readonly outerHtml?: string
  readonly content?: string
  readonly boundingBox?: BrowserBox
}

const OUTER_HTML_MAX_CHARS = 2049
const SELECTOR_MAX_CHARS = 2048
const TAG_NAME_MAX_CHARS = 128
const FRAME_URL_MAX_CHARS = 8192
const CONTENT_MAX_CHARS = 8192

type GuestField<T> = { readonly ok: boolean; readonly value?: T }

function guestString(value: unknown, maxChars: number): GuestField<string> {
  if (value === undefined) return { ok: true }
  return typeof value === "string" && value.length <= maxChars ? { ok: true, value } : { ok: false }
}

function guestBox(value: unknown): GuestField<BrowserBox> {
  if (value === undefined) return { ok: true }
  if (!isRecord(value)) return { ok: false }
  const [x, y, width, height] = [value.x, value.y, value.width, value.height].map(asFiniteNumber)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return { ok: false }
  return { ok: true, value: { x, y, width, height } }
}

export function readGuestPickPayload(value: unknown): GuestPickPayload | undefined {
  if (!isRecord(value)) return undefined
  const selector = guestString(value.selector, SELECTOR_MAX_CHARS)
  const frameUrl = guestString(value.frameUrl, FRAME_URL_MAX_CHARS)
  const tagName = guestString(value.tagName, TAG_NAME_MAX_CHARS)
  const outerHtml = guestString(value.outerHTML, OUTER_HTML_MAX_CHARS)
  const content = guestString(value.content, CONTENT_MAX_CHARS)
  const boundingBox = guestBox(value.boundingBox)
  const fields = [selector, frameUrl, tagName, outerHtml, content, boundingBox]
  if (selector.value === undefined || fields.some((field) => !field.ok)) return undefined
  return {
    selector: selector.value,
    frameUrl: frameUrl.value,
    tagName: tagName.value,
    outerHtml: outerHtml.value,
    content: content.value,
    boundingBox: boundingBox.value,
  }
}

export function guestMessageArgument(event: { readonly args?: unknown[] }): unknown {
  return Array.isArray(event.args) ? event.args[0] : undefined
}

export function guestCommentText(content: string | undefined): string {
  const text = content ?? ""
  const split = text.indexOf("\n\n")
  const comment = split >= 0 ? text.slice(0, split).trim() : ""
  return comment || text.trim()
}
