import { sessionComposerKey, useComposerStore, type ImagePart } from "@/composer"
import { useActiveSession } from "@/files"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { dictionary, type BrowserKey } from "./i18n"
import type { PickedElement } from "./model"
import { hostOf } from "./url"

const SNIPPET_MAX_CHARS = 600

export type PickDelivery = (pick: PickedElement) => boolean

function pickLabel(t: DomainTranslate<BrowserKey>, pick: PickedElement): string {
  const host = hostOf(pick.pageUrl)
  return pick.selector ? t("browser.pick.label", { tag: pick.tagName, host }) : t("browser.screenshot.label", { host })
}

function pickText(pick: PickedElement): string {
  const lines = [`Page: ${pick.pageUrl}`, `Element: <${pick.tagName}> ${pick.selector}`]
  if (pick.outerHtml) lines.push(pick.outerHtml.slice(0, SNIPPET_MAX_CHARS))
  if (pick.comment) lines.push("", pick.comment)
  return lines.join("\n")
}

function screenshotPart(pick: PickedElement): ImagePart | undefined {
  const dataUrl = pick.screenshotDataUrl
  if (!dataUrl?.startsWith("data:image/")) return undefined
  const mimeEnd = dataUrl.indexOf(";", 5)
  const mime = mimeEnd > 5 ? dataUrl.slice(5, mimeEnd) : "image/png"
  const selector =
    (pick.selector || "page")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "page"
  return {
    type: "image",
    id: pick.id,
    filename: `browser-${selector}-${pick.id}.${mime.split("/")[1] ?? "png"}`,
    mime,
    dataUrl,
  }
}

export function usePickDelivery(): PickDelivery {
  const t = useTranslator(dictionary)
  const composer = useComposerStore()
  const session = useActiveSession()
  return (pick) => {
    const ref = session()
    if (!ref) return false
    const key = sessionComposerKey(ref)
    if (pick.selector)
      composer.addContext(key, {
        type: "text",
        key: `browser:${pick.id}`,
        label: pickLabel(t, pick),
        text: pickText(pick),
      })
    const image = screenshotPart(pick)
    if (image) composer.addPart(key, image)
    return true
  }
}
