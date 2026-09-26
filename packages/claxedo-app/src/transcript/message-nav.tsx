import type { AgentSnapshotFileDiff } from "@claxedo/agent-runtime-contract"
import { HoverCard, useHoverCardContext } from "@kobalte/core/hover-card"
import {
  ComponentProps,
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  splitProps,
} from "solid-js"
import { DiffChanges } from "@/ui"
import { useTranscriptI18n } from "./i18n"

export type MessageNavPreview = {
  user?: string
  assistant?: string
}

export type MessageNavMessage = {
  id: string
  summary?: { title?: string; diffs?: AgentSnapshotFileDiff[] }
}

export function MessageNav<M extends MessageNavMessage>(
  props: ComponentProps<"ul"> & {
    messages: M[]
    current?: M
    size: "normal" | "compact"
    onMessageSelect: (message: M) => void
    getLabel?: (message: M) => string | undefined
    getPreview?: (message: M) => MessageNavPreview
  },
) {
  const i18n = useTranscriptI18n()
  const [local, others] = splitProps(props, [
    "messages",
    "current",
    "size",
    "onMessageSelect",
    "getLabel",
    "getPreview",
    "class",
  ])
  const [activePreview, setActivePreview] = createSignal<string>()
  const [pendingPreview, setPendingPreview] = createSignal<M>()
  let previewSwitchTimer: number | undefined

  const cancelPreviewSwitch = () => {
    window.clearTimeout(previewSwitchTimer)
    previewSwitchTimer = undefined
  }

  onCleanup(cancelPreviewSwitch)

  const focusIndex = () => {
    const id = activePreview() ?? local.current?.id
    const index = local.messages.findIndex((message) => message.id === id)
    return index >= 0 ? index : local.messages.length - 1
  }

  const selectMessage = (message: M) => {
    local.onMessageSelect(message)
  }

  const fallbackLabel = (message: M) =>
    local.getLabel?.(message) ?? message.summary?.title ?? i18n.t("transcript.messageNav.newMessage")

  const activePreviewMessage = createMemo(() => {
    const id = activePreview()
    if (!id) return undefined
    return local.messages.find((message) => message.id === id)
  })

  const closePreview = () => {
    cancelPreviewSwitch()
    batch(() => {
      setPendingPreview(undefined)
      setActivePreview(undefined)
    })
  }

  const CompactContent = () => {
    const hoverCard = useHoverCardContext()

    createEffect(on(() => local.messages, (messages) => {
      const ids = new Set(messages.map((message) => message.id))
      const pending = pendingPreview()
      if (pending && !ids.has(pending.id)) {
        cancelPreviewSwitch()
        hoverCard.cancelOpening()
        setPendingPreview(() => activePreviewMessage())
      }

      const active = activePreview()
      if (!active || ids.has(active)) return
      hoverCard.cancelOpening()
      hoverCard.close()
      closePreview()
    }))

    const beginPreview = (message: M, trigger: HTMLButtonElement) => {
      hoverCard.cancelClosing()

      if (!hoverCard.isOpen()) {
        cancelPreviewSwitch()
        hoverCard.cancelOpening()
        hoverCard.setTriggerRef(trigger)
        setPendingPreview(() => message)
        hoverCard.openWithDelay()
        return
      }

      if (activePreview() === message.id) return

      cancelPreviewSwitch()
      setPendingPreview(() => message)
      previewSwitchTimer = window.setTimeout(() => {
        previewSwitchTimer = undefined
        batch(() => {
          hoverCard.setTriggerRef(trigger)
          setActivePreview(message.id)
        })
      }, 140)
    }

    const cancelPendingPreview = (message: M) => {
      if (pendingPreview()?.id !== message.id) return
      cancelPreviewSwitch()
      hoverCard.cancelOpening()
      setPendingPreview(() => activePreviewMessage())
    }

    const selectCompactMessage = (message: M) => {
      closePreview()
      hoverCard.close()
      selectMessage(message)
    }

    return (
      <>
        <ul
          role="list"
          data-component="message-nav"
          data-size="compact"
          onPointerMove={() => hoverCard.cancelClosing()}
          {...others}
        >
          <For each={local.messages}>
            {(message, index) => {
              const active = () => message.id === local.current?.id
              return (
                <li data-slot="message-nav-item">
                  <button
                    type="button"
                    data-slot="message-nav-tick-button"
                    data-message-id={message.id}
                    data-active={active() || undefined}
                    data-distance={Math.min(Math.abs(index() - focusIndex()), 4)}
                    aria-current={active() ? "step" : undefined}
                    aria-label={`${index() + 1}. ${fallbackLabel(message)}`}
                    onPointerEnter={(event) => {
                      if (event.pointerType === "touch" || event.defaultPrevented) return
                      beginPreview(message, event.currentTarget)
                    }}
                    onPointerLeave={(event) => {
                      if (event.pointerType === "touch") return
                      cancelPendingPreview(message)
                    }}
                    onFocus={(event) => {
                      if (event.defaultPrevented) return
                      beginPreview(message, event.currentTarget)
                    }}
                    onBlur={(event) => {
                      cancelPendingPreview(message)
                      const related = event.relatedTarget
                      if (related instanceof Node && hoverCard.isTargetOnHoverCard(related)) return
                      hoverCard.closeWithDelay()
                    }}
                    onClick={() => selectCompactMessage(message)}
                  >
                    <span class="ui-message-nav-tick-line" />
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
        <HoverCard.Portal>
          <Show when={activePreviewMessage()} keyed>
            {(message) => {
              const preview = () => local.getPreview?.(message)
              return (
                <HoverCard.Content
 class="ui-message-nav-turn-preview"
                  onClick={() => selectCompactMessage(message)}
                >
                  <div data-slot="message-nav-preview-copy">
                    <p class="ui-message-nav-preview-user">{preview()?.user ?? fallbackLabel(message)}</p>
                    <Show when={preview()?.assistant}>
                      {(assistant) => <p class="ui-message-nav-preview-assistant">{assistant()}</p>}
                    </Show>
                  </div>
                </HoverCard.Content>
              )
            }}
          </Show>
        </HoverCard.Portal>
      </>
    )
  }

  const normalContent = () => (
    <ul role="list" data-component="message-nav" data-size="normal" class={local.class} {...others}>
      <For each={local.messages}>
        {(message) => {
          const handleClick = () => selectMessage(message)

          const handleKeyPress = (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            selectMessage(message)
          }

          return (
            <li data-slot="message-nav-item">
              <button
 class="ui-message-nav-message-button"
                data-message-id={message.id}
                onClick={handleClick}
                onKeyDown={handleKeyPress}
              >
                <DiffChanges changes={message.summary?.diffs ?? []} />
                <div
                  data-slot="message-nav-title-preview" class="ui-message-nav-title-preview"
                  data-active={message.id === local.current?.id || undefined}
                >
                  <Show
                    when={local.getLabel?.(message) ?? message.summary?.title}
                    fallback={i18n.t("transcript.messageNav.newMessage")}
                  >
                    {local.getLabel?.(message) ?? message.summary?.title}
                  </Show>
                </div>
              </button>
            </li>
          )
        }}
      </For>
    </ul>
  )

  return (
    <Show when={local.size === "normal" || local.messages.length > 10}>
      <Switch>
        <Match when={local.size === "compact"}>
          <div class={local.class}>
            <HoverCard
              open={activePreview() !== undefined}
              onOpenChange={(next) => {
                if (!next) {
                  closePreview()
                  return
                }
                const message = pendingPreview()
                if (message) setActivePreview(message.id)
              }}
              openDelay={140}
              closeDelay={160}
              placement="right"
              gutter={10}
              overflowPadding={24}
              fitViewport
            >
              <CompactContent />
            </HoverCard>
          </div>
        </Match>
        <Match when={local.size === "normal"}>{normalContent()}</Match>
      </Switch>
    </Show>
  )
}
