import { createSignal, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/platform/i18n/provider"
import { useSettings } from "@/platform/settings/provider"
import { prefersReducedMotion } from "@/ui/controls/reduced-motion"

export type Highlight = {
  title: string
  description: string
  media?: {
    type: "image" | "video"
    src: string
    alt?: string
  }
}

export function DialogReleaseNotes(props: { highlights: Highlight[] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const [index, setIndex] = createSignal(0)

  const reduceMotion = prefersReducedMotion()
  const [videoEl, setVideoEl] = createSignal<HTMLVideoElement>()
  // Start paused when the user prefers reduced motion (autoplay is suppressed
  // there); otherwise the muted loop autoplays.
  const [videoPaused, setVideoPaused] = createSignal(reduceMotion)

  function toggleVideo() {
    const el = videoEl()
    if (!el) return
    if (el.paused) {
      void el.play()
      setVideoPaused(false)
    } else {
      el.pause()
      setVideoPaused(true)
    }
  }

  const total = () => props.highlights.length
  const last = () => Math.max(0, total() - 1)
  const feature = () => props.highlights[index()] ?? props.highlights[last()]
  const isFirst = () => index() === 0
  const isLast = () => index() >= last()
  const paged = () => total() > 1

  function handleNext() {
    if (isLast()) return
    setIndex(index() + 1)
  }

  function handleClose() {
    dialog.close()
  }

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    handleClose()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      handleClose()
      return
    }

    if (!paged()) return
    if (e.key === "ArrowLeft" && !isFirst()) {
      e.preventDefault()
      setIndex(index() - 1)
    }
    if (e.key === "ArrowRight" && !isLast()) {
      e.preventDefault()
      setIndex(index() + 1)
    }
  }

  return (
    <Dialog
      size="large"
      fit
      class="w-[min(calc(100vw-40px),720px)] h-[min(calc(100vh-40px),400px)] -mt-20 min-h-0 overflow-hidden"
    >
      <div class="flex flex-1 min-w-0 min-h-0" tabindex={0} autofocus onKeyDown={handleKeyDown}>
        {/* Left side - Text content */}
        <div class="flex flex-col flex-1 min-w-0 p-8">
          {/* Top section - feature content (fixed position from top) */}
          <div class="flex flex-col gap-2 pt-22">
            <div class="flex items-center gap-2">
              <h1 class="text-16-medium text-text-strong">{feature()?.title ?? ""}</h1>
            </div>
            <p class="text-14-regular text-text-base">{feature()?.description ?? ""}</p>
          </div>

          {/* Spacer to push buttons to bottom */}
          <div class="flex-1" />

          {/* Bottom section - buttons and indicators (fixed position) */}
          <div class="flex flex-col gap-12">
            <div class="flex flex-col items-start gap-3">
              {isLast() ? (
                <Button variant="primary" size="large" onClick={handleClose}>
                  {language.t("dialog.releaseNotes.action.getStarted")}
                </Button>
              ) : (
                <Button variant="secondary" size="large" onClick={handleNext}>
                  {language.t("dialog.releaseNotes.action.next")}
                </Button>
              )}

              <Button variant="ghost" size="small" onClick={handleDisable}>
                {language.t("dialog.releaseNotes.action.hideFuture")}
              </Button>
            </div>

            {paged() && (
              <div class="flex items-center gap-1.5 -my-2.5">
                {props.highlights.map((_, i) => (
                  <button
                    type="button"
                    class={[
                      "h-6 flex items-center cursor-pointer bg-transparent border-none p-0 transition-all duration-200",
                      {
                        "w-8": i === index(),
                        "w-3": i !== index(),
                      },
                    ]}

                    onClick={() => setIndex(i)}
                  >
                    <div
                      class={[
                        "w-full h-0.5 rounded-[var(--radius-2xs)] transition-colors duration-200",
                        {
                          "bg-icon-strong-base": i === index(),
                          "bg-icon-weak-base": i !== index(),
                        },
                      ]}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right side - Media content (edge to edge) */}
        {feature()?.media && (
          <div class="flex-1 min-w-0 bg-surface-base overflow-hidden rounded-r-xl">
            {feature()!.media!.type === "image" ? (
              <img
                src={feature()!.media!.src}
                alt={feature()!.media!.alt ?? feature()?.title ?? language.t("dialog.releaseNotes.media.alt")}
                class="w-full h-full object-cover"
              />
            ) : (
              <div class="relative w-full h-full">
                <video
                  ref={setVideoEl}
                  src={feature()!.media!.src}
                  autoplay={!reduceMotion}
                  loop
                  muted
                  playsinline
                  aria-label={feature()!.media!.alt ?? feature()?.title ?? language.t("dialog.releaseNotes.media.alt")}
                  class="w-full h-full object-cover"
                />
                {/* WCAG 2.2.2 (Pause, Stop, Hide): the release-notes clip is an
                    auto-playing loop, so it needs a control to stop it. */}
                <button
                  type="button"
                  onClick={toggleVideo}
                  aria-label={language.t(
                    videoPaused() ? "dialog.releaseNotes.media.play" : "dialog.releaseNotes.media.pause",
                  )}
                  class="absolute bottom-2 right-2 flex size-7 items-center justify-center rounded-md border-none bg-[var(--media-control-surface)] text-[var(--media-control-text)] backdrop-blur-sm transition-colors hover:bg-[var(--media-control-surface-hover)]"
                >
                  <Show
                    when={videoPaused()}
                    fallback={
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
                        <rect x="2" y="1.5" width="3" height="9" rx="0.75" />
                        <rect x="7" y="1.5" width="3" height="9" rx="0.75" />
                      </svg>
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
                      <path d="M2.5 1.6c0-.5.53-.8.95-.54l7 4.4a.64.64 0 0 1 0 1.08l-7 4.4a.64.64 0 0 1-.95-.54V1.6Z" />
                    </svg>
                  </Show>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
