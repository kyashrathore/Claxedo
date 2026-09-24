import { createMemo, type Accessor } from "solid-js"
import type { PromptAttachment } from "@/server"
import { t } from "./i18n"
import type { PickedElement } from "./model"
import { useBrowserTab } from "./store"
import { hostOf } from "./url"

export type ComposerItem = {
  readonly id: string
  readonly label: string
  readonly attachment: PromptAttachment
}

export type ComposerItems = {
  readonly items: Accessor<readonly ComposerItem[]>
  readonly remove: (id: string) => void
  readonly take: () => readonly PromptAttachment[]
}

const SNIPPET_MAX_CHARS = 600

export function pickLabel(pick: PickedElement): string {
  const host = hostOf(pick.pageUrl)
  return pick.selector ? t("browser.pick.label", { tag: pick.tagName, host }) : t("browser.screenshot.label", { host })
}

export function pickText(pick: PickedElement): string {
  const lines = [`Page: ${pick.pageUrl}`, `Element: <${pick.tagName}> ${pick.selector}`]
  if (pick.outerHtml) lines.push(pick.outerHtml.slice(0, SNIPPET_MAX_CHARS))
  if (pick.comment) lines.push("", pick.comment)
  return lines.join("\n")
}

export function screenshotAttachment(pick: PickedElement): PromptAttachment | undefined {
  const dataUrl = pick.screenshotDataUrl
  if (!dataUrl?.startsWith("data:image/")) return undefined
  const mimeEnd = dataUrl.indexOf(";", 5)
  const mime = mimeEnd > 5 ? dataUrl.slice(5, mimeEnd) : "image/png"
  const selector = (pick.selector || "page").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "page"
  return { kind: "image", dataUrl, mime, name: `browser-${selector}-${pick.id}.${mime.split("/")[1] ?? "png"}` }
}

export function pickAttachments(pick: PickedElement): readonly PromptAttachment[] {
  const attachments: PromptAttachment[] = []
  if (pick.selector) attachments.push({ kind: "text", text: pickText(pick), label: pickLabel(pick) })
  const image = screenshotAttachment(pick)
  if (image) attachments.push(image)
  return attachments
}

export function usePickToComposer(): ComposerItems {
  const tab = useBrowserTab()
  const items = createMemo(() =>
    (tab()?.picks() ?? []).flatMap((pick) => {
      const attachment = pickAttachments(pick)[0]
      return attachment ? [{ id: pick.id, label: pickLabel(pick), attachment }] : []
    }),
  )
  return {
    items,
    remove: (id) => tab()?.removePick(id),
    take: () => (tab()?.takePicks() ?? []).flatMap(pickAttachments),
  }
}
