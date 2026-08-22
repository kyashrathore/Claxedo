import { UserMessage } from "@opencode-ai/sdk/v2"
import { HoverCard } from "@kobalte/core/hover-card"
import { ComponentProps, For, Match, Show, createEffect, createMemo, createSignal, splitProps, Switch } from "solid-js"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { useI18n } from "@opencode-ai/ui/context/i18n"

export type MessageNavPreview = {
  user?: string
  assistant?: string
}

/** Turns represented per minimap page; larger sessions page instead of densifying into a block. */
const MESSAGE_NAV_PAGE = 30

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

  // Paged minimap: show MESSAGE_NAV_PAGE turns at a time so a huge session
  // never densifies into an unreadable block. The page follows the current
  // turn; the pager re-scopes the map without jumping the transcript.
  const pageCount = () => Math.max(1, Math.ceil(local.messages.length / MESSAGE_NAV_PAGE))
  const [page, setPage] = createSignal(0)
  const clampedPage = () => Math.min(page(), pageCount() - 1)
  const pagedMessages = createMemo(() => {
    const start = clampedPage() * MESSAGE_NAV_PAGE
    return local.messages.slice(start, start + MESSAGE_NAV_PAGE)
  })
  createEffect(() => {
    if (local.messages.length <= MESSAGE_NAV_PAGE) return
    const index = local.messages.findIndex((message) => message.id === local.current?.id)
    if (index >= 0) setPage(Math.floor(index / MESSAGE_NAV_PAGE))
  })
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

  const compactItem = (message: UserMessage, index: () => number) => {
    const open = () => activePreview() === message.id
    // Preview text joins every part of the turn — compute it only for the one
    // OPEN hover card, never eagerly for all ticks (a 400-turn session would
    // otherwise walk every part of every turn just to render the rail).
    const preview = () => (open() ? local.getPreview?.(message) : undefined)
    const user = () => preview()?.user ?? fallbackLabel(message)
    const active = () => message.id === local.current?.id

    return (
      <HoverCard
        open={open()}
        onOpenChange={(next) => {
          if (next) {
            setActivePreview(message.id)
            return
          }
          if (open()) setActivePreview(undefined)
        }}
        openDelay={140}
        closeDelay={160}
        placement="right"
        gutter={10}
        overflowPadding={24}
        fitViewport
      >
        <HoverCard.Trigger
          as="button"
          type="button"
          data-slot="message-nav-tick-button"
          data-message-id={message.id}
          data-active={active() || undefined}
          data-distance={Math.min(Math.abs(index() - focusIndex()), 4)}
          aria-current={active() ? "step" : undefined}
          aria-label={`${index() + 1}. ${fallbackLabel(message)}`}
          onClick={() => {
            setActivePreview(undefined)
            selectMessage(message)
          }}
        >
          <span data-slot="message-nav-tick-line" />
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            data-slot="message-nav-turn-preview"
            style={{ display: open() ? undefined : "none" }}
            onClick={() => {
              setActivePreview(undefined)
              selectMessage(message)
            }}
          >
            <div data-slot="message-nav-preview-copy">
              <p data-slot="message-nav-preview-user">{user()}</p>
              <Show when={preview()?.assistant}>
                {(assistant) => <p data-slot="message-nav-preview-assistant">{assistant()}</p>}
              </Show>
            </div>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard>
    )
  }

  // Edge rows double as the paging window movers: the top slot pages to earlier
  // turns, the bottom slot to later ones, each drawn with a continuation mark
  // while more turns exist beyond that edge.
  const goPage = (delta: number) => setPage(Math.min(pageCount() - 1, Math.max(0, clampedPage() + delta)))
  const pagedMode = () => local.messages.length > MESSAGE_NAV_PAGE
  const pageMover = (dir: "prev" | "next") => {
    const disabled = dir === "prev" ? clampedPage() === 0 : clampedPage() >= pageCount() - 1
    return (
      <li data-slot="message-nav-item">
        <button
          type="button"
          data-slot={`message-nav-page-${dir}`}
          disabled={disabled}
          aria-label={dir === "prev" ? "Earlier turns" : "Later turns"}
          onClick={() => goPage(dir === "prev" ? -1 : 1)}
        >
          <span data-slot="message-nav-tick-line" />
          <span data-slot="message-nav-page-dots" aria-hidden="true">
            {"···"}
          </span>
        </button>
      </li>
    )
  }

  const content = (className?: string, items: readonly UserMessage[] = local.messages) => (
    <ul role="list" data-component="message-nav" data-size={local.size} class={className} {...others}>
      {local.size === "compact" && pagedMode() ? pageMover("prev") : null}
      <For each={items}>
        {(message, index) => {
          const handleClick = () => selectMessage(message)

          const handleKeyPress = (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            selectMessage(message)
          }

          return (
            <li data-slot="message-nav-item">
              <Switch>
                <Match when={local.size === "compact"}>
                  {compactItem(message, index)}
                </Match>
                <Match when={local.size === "normal"}>
                  <button
                    data-slot="message-nav-message-button"
                    data-message-id={message.id}
                    onClick={handleClick}
                    onKeyDown={handleKeyPress}
                  >
                    <DiffChanges changes={message.summary?.diffs ?? []} variant="bars" />
                    <div
                      data-slot="message-nav-title-preview"
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
                </Match>
              </Switch>
            </li>
          )
        }}
      </For>
      {local.size === "compact" && pagedMode() ? pageMover("next") : null}
    </ul>
  )

  return (
    <Show when={local.size === "normal" || local.messages.length > 10}>
      <Switch>
        <Match when={local.size === "compact"}>
          <div data-component="message-nav-hovercard" class={local.class}>
            {content(undefined, pagedMessages())}
          </div>
        </Match>
        <Match when={local.size === "normal"}>{content(local.class)}</Match>
      </Switch>
    </Show>
  )
}
