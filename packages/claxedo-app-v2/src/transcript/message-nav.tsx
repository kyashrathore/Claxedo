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
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { useI18n } from "@opencode-ai/ui/context/i18n"

export type MessageNavPreview = {
  user?: string
  assistant?: string
}

/**
 * What this nav reads off a turn's user message: its id, and the summary it
 * renders a label and diff bars from.
 *
 * Structural rather than `AgentUserMessage` — that contract also requires
 * `agent` and `model`, which this component never touches and which a row the
 * runtime has not echoed back yet does not have. Naming only the fields read
 * keeps a caller free to pass an optimistic turn.
 */
export type MessageNavMessage = {
  id: string
  summary?: { title?: string; diffs?: AgentSnapshotFileDiff[] }
}

/**
 * Generic over the row type so the callbacks hand back what the caller passed
 * in. Typing them as `MessageNavMessage` would make the nav claim it can invoke
 * a handler with a bare `{id}`, which no caller writes one for.
 */
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
  const i18n = useI18n()
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
    local.getLabel?.(message) ?? message.summary?.title ?? i18n.t("ui.messageNav.newMessage")

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
                      // `relatedTarget` is an `EventTarget`; kobalte compares it against its
                      // content node, so anything that is not a Node can never be inside it.
                      const related = event.relatedTarget
                      if (related instanceof Node && hoverCard.isTargetOnHoverCard(related)) return
                      hoverCard.closeWithDelay()
                    }}
                    onClick={() => selectCompactMessage(message)}
                  >
                    <span data-slot="message-nav-tick-line" class="ui-message-nav-tick-line" />
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
        <HoverCard.Portal>
          <Show when={activePreviewMessage()} keyed>
            {(message) => {
              // Preview text joins every part of the turn — compute it only for
              // the one open card, never eagerly for every history tick.
              const preview = () => local.getPreview?.(message)
              return (
                <HoverCard.Content
                  data-slot="message-nav-turn-preview" class="ui-message-nav-turn-preview"
                  onClick={() => selectCompactMessage(message)}
                >
                  <div data-slot="message-nav-preview-copy">
                    <p data-slot="message-nav-preview-user" class="ui-message-nav-preview-user">{preview()?.user ?? fallbackLabel(message)}</p>
                    <Show when={preview()?.assistant}>
                      {(assistant) => <p data-slot="message-nav-preview-assistant" class="ui-message-nav-preview-assistant">{assistant()}</p>}
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
                data-slot="message-nav-message-button" class="ui-message-nav-message-button"
                data-message-id={message.id}
                onClick={handleClick}
                onKeyDown={handleKeyPress}
              >
                <DiffChanges changes={message.summary?.diffs ?? []} variant="bars" />
                <div
                  data-slot="message-nav-title-preview" class="ui-message-nav-title-preview"
                  data-active={message.id === local.current?.id || undefined}
                >
                  <Show
                    when={local.getLabel?.(message) ?? message.summary?.title}
                    fallback={i18n.t("ui.messageNav.newMessage")}
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
          <div data-component="message-nav-hovercard" class={local.class}>
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
