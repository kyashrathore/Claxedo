import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { AgentFileLocation, AgentFilePart } from "@claxedo/agent-runtime-contract"
import { useDialog, Icon, ImagePreview } from "@/ui"
import { getFilename } from "@/ui/utils"
import { useData } from "./data"
import { useTranscriptI18n } from "./i18n"

export function useImagePreview() {
  const dialog = useDialog()
  return (url: string, alt?: string) => void dialog.show(() => <ImagePreview src={url} alt={alt} />)
}

function ToolImageStrip(props: { images: AgentFilePart[] }) {
  const data = useData()
  const openImagePreview = useImagePreview()
  return (
    <For each={props.images}>
      {(image) => {
        const name = () => image.filename ?? getFilename(image.url) ?? image.url
        const [loaded, setLoaded] = createSignal<string>()
        const [loadFailed, setLoadFailed] = createSignal(false)
        const [attempt, setAttempt] = createSignal(0)
        const retry = () => setAttempt((value) => value + 1)
        createEffect(() => {
          attempt()
          if (image.location?.kind !== "tool-file" || !data.readToolImage) return
          const controller = new AbortController()
          let objectUrl: string | undefined
          setLoaded(undefined)
          setLoadFailed(false)
          void data.readToolImage(image, controller.signal).then((blob) => {
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(blob)
            setLoaded(objectUrl)
          }).catch((error: unknown) => {
            if (controller.signal.aborted) return
            console.warn("A tool image could not be read", { error })
            setLoadFailed(true)
          })
          onCleanup(() => {
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
          })
        })
        const src = createMemo(() => {
          const location = image.location
          if (!location) return image.url
          if (location.kind === "unretained") return undefined
          if (location.kind === "tool-file") return loaded()
          return data.fileUrl?.(location.path)
        })
        return (
          <div class="ui-tool-image">
            <Show when={src()} fallback={<ToolImageUnavailable name={name()} location={image.location} onRetry={loadFailed() ? retry : undefined} />}>
              {(url) => {
                const [failed, setFailed] = createSignal(false)
                return (
                  <Show when={!failed()} fallback={<ToolImageUnavailable name={name()} location={image.location} />}>
                    <button
                      type="button"
                      data-slot="tool-image-open"
                      aria-label={name()}
                      onClick={() => openImagePreview(url(), name())}
                    >
                      <img
                        data-slot="tool-image-thumbnail"
                        src={url()}
                        alt={name()}
                        onError={() => setFailed(true)}
                      />
                    </button>
                  </Show>
                )
              }}
            </Show>
          </div>
        )
      }}
    </For>
  )
}

export function ToolAttachments(props: { attachments?: AgentFilePart[] }) {
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  return (
    <Show when={images().length > 0}>
      <ToolImageStrip images={images()} />
    </Show>
  )
}

function ToolImageUnavailable(props: { name: string; location?: AgentFileLocation; onRetry?: () => void }) {
  const i18n = useTranscriptI18n()
  const [expanded, setExpanded] = createSignal(false)
  const unretained = () => (props.location?.kind === "unretained" ? props.location : undefined)
  const label = () => (
    <>
      <Icon name="photo" size="small" />
      <span>{props.name}</span>
    </>
  )
  return (
    <div class="ui-tool-image-unavailable">
      <Show
        when={unretained()}
        fallback={
          <div data-slot="tool-image-unavailable-row">
            {label()}
            <Show when={props.onRetry}>
              <button type="button" onClick={props.onRetry}>{i18n.t("transcript.message.queued.retry")}</button>
            </Show>
          </div>
        }
      >
        {(location) => {
          const size = () => `${Math.round(location().bytes / 1024)} KB`
          return (
            <>
              <button
                type="button"
                data-slot="tool-image-unavailable-row"
                aria-expanded={expanded()}
                onClick={() => setExpanded((value) => !value)}
              >
                {label()}
                <span data-slot="tool-image-size">{size()}</span>
                <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
              </button>
              <Show when={expanded()}>
                <div data-slot="tool-image-unavailable-note">
                  <Icon name="photo" size="large" />
                  <span>{i18n.t("transcript.tool.image.tooLarge", { size: size() })}</span>
                </div>
              </Show>
            </>
          )
        }}
      </Show>
    </div>
  )
}
