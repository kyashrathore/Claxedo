import { createEffect, createSignal, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"

const PREVIEW_DOCUMENT = "/browser-preview.html"

function sourceFrame(document: Document, title: string, loaded: () => void): HTMLIFrameElement {
  const frame = document.createElement("iframe")
  frame.title = title
  frame.setAttribute("sandbox", "")
  frame.referrerPolicy = "no-referrer"
  frame.addEventListener("load", loaded)
  return frame
}

function PreviewDocument(props: { readonly url: string; readonly title: string; readonly loaded: (url: string) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const [previewDocument, setPreviewDocument] = createSignal<Document>()
  let source: HTMLIFrameElement | undefined
  let shown: string | undefined
  createEffect(() => {
    const document = previewDocument()
    const url = props.url
    if (!document || url === shown) return
    shown = url
    if (source) {
      source.src = url
      return
    }
    source = sourceFrame(document, props.title, () => shown && props.loaded(shown))
    source.src = url
    document.body.append(source)
  })
  const opened = (host: HTMLIFrameElement) => {
    source = undefined
    shown = undefined
    setPreviewDocument(host.contentDocument ?? undefined)
  }
  return (
    <iframe
      src={PREVIEW_DOCUMENT}
      title={t("browser.preview.document")}
      class="size-full border-0 bg-background-base"
      onLoad={(event) => opened(event.currentTarget)}
    />
  )
}

export function WebPreview(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const url = () => props.tab.state().url
  const blocked = () => typeof location !== "undefined" && location.protocol === "https:" && url().startsWith("http:")
  return (
    <Show
      when={url() && !blocked() ? url() : undefined}
      fallback={
        <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <div class="font-medium text-text-base">
            {blocked() ? t("browser.mixedContent.title") : t("browser.web.title")}
          </div>
          <div>{blocked() ? t("browser.mixedContent.hint") : t("browser.web.hint")}</div>
        </div>
      }
    >
      {(src) => <PreviewDocument url={src()} title={t("browser.preview.title")} loaded={(loaded) => props.tab.send({ type: "loaded", url: loaded })} />}
    </Show>
  )
}
