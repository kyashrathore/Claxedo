import { UserMessage } from "@opencode-ai/sdk/v2"
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

export function MessageNav(
  props: ComponentProps<"ul"> & {
    messages: UserMessage[]
    current?: UserMessage
    size: "normal" | "compact"
    onMessageSelect: (message: UserMessage) => void
    getLabel?: (message: UserMessage) => string | undefined
    getPreview?: (message: UserMessage) => MessageNavPreview
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
  const [pendingPreview, setPendingPreview] = createSignal<UserMessage>()
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

  const selectMessage = (message: UserMessage) => {
    local.onMessageSelect(message)
  }

  const fallbackLabel = (message: UserMessage) =>
    local.getLabel?.(message) ?? message.summary?.title ?? i18n.t("ui.messageNav.newMessage")

  const activePreviewMessage = createMemo(() => {
    const id = activePreview()
    if (!id) return
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
        setPendingPreview(activePreviewMessage())
      }

      const active = activePreview()
      if (!active || ids.has(active)) return
      hoverCard.cancelOpening()
      hoverCard.close()
      closePreview()
    }))

    const beginPreview = (message: UserMessage, trigger: HTMLButtonElement) => {
      hoverCard.cancelClosing()

      if (!hoverCard.isOpen()) {
        cancelPreviewSwitch()
        hoverCard.cancelOpening()
        hoverCard.setTriggerRef(trigger)
        setPendingPreview(message)
        hoverCard.openWithDelay()
        return
      }

      if (activePreview() === message.id) return

      cancelPreviewSwitch()
      setPendingPreview(message)
      previewSwitchTimer = window.setTimeout(() => {
        previewSwitchTimer = undefined
        batch(() => {
          hoverCard.setTriggerRef(trigger)
          setActivePreview(message.id)
        })
      }, 140)
    }

    const cancelPendingPreview = (message: UserMessage) => {
      if (pendingPreview()?.id !== message.id) return
      cancelPreviewSwitch()
      hoverCard.cancelOpening()
      setPendingPreview(activePreviewMessage())
    }

    const selectCompactMessage = (message: UserMessage) => {
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
                      if (hoverCard.isTargetOnHoverCard(event.relatedTarget as Node | null)) return
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
