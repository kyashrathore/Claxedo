import { UserMessage } from "@opencode-ai/sdk/v2"
import { HoverCard } from "@kobalte/core/hover-card"
import { ComponentProps, For, Index, Match, Show, createEffect, createMemo, createSignal, splitProps, Switch } from "solid-js"
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

  // Always-centred minimap: the SELECTED turn renders at the middle of a
  // fixed 30-row window. Slots beyond either end of the session stay visible
  // as very dim disabled rows, so the rail never reflows when history runs
  // out above/below the selection.
  const WINDOW_SLIDE = Math.floor(MESSAGE_NAV_PAGE / 2)
  const SLIDE_ANIMATE_MS = 180
  const maxWindowStart = () => Math.max(0, local.messages.length - MESSAGE_NAV_PAGE)
  const [windowStart, setWindowStart] = createSignal(0)
  const clampedWindowStart = () => Math.min(Math.max(0, windowStart()), maxWindowStart())
  const currentIndex = () => {
    const index = local.messages.findIndex((message) => message.id === local.current?.id)
    return index >= 0 ? index : local.messages.length - 1
  }
  const [slide, setSlide] = createSignal<-1 | 0 | 1>(0)
  const animateSlide = (dir: -1 | 1) => {
    setSlide(0)
    requestAnimationFrame(() => setSlide(dir))
  }
  const rowMessages = createMemo(() => {
    const start = clampedWindowStart()
    return Array.from({ length: MESSAGE_NAV_PAGE }, (_, i) => local.messages[start + i])
  })
  createEffect(() => {
    if (local.messages.length <= MESSAGE_NAV_PAGE) return
    setWindowStart(currentIndex() - WINDOW_SLIDE)
  })

  // Hover preview must not resurrect after a click dismisses it while the
  // pointer still rests on the tick; hold it closed until the pointer leaves.
  const [suppressHover, setSuppressHover] = createSignal(false)
  const focusIndex = () => {
    const id = activePreview() ?? local.current?.id
    const index = local.messages.findIndex((message) => message.id === id)
    return index >= 0 ? index : local.messages.length - 1
  }

  const selectMessage = (message: UserMessage) => {
    // Rail-first sequencing: picking a tick away from the centre slides the
    // rail FIRST (the tick reads as moving to the centre), then jumps the
    // transcript once the rail has settled.
    const globalIndex = local.messages.findIndex((item) => item.id === message.id)
    if (globalIndex >= 0 && pagedMode() && Math.abs(globalIndex - currentIndex()) > 2) {
      animateSlide(globalIndex < currentIndex() ? -1 : 1)
      setTimeout(() => local.onMessageSelect(message), SLIDE_ANIMATE_MS)
      return
    }
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
    // Distance for the peak/taper effect must be global (across pages), not
    // the page-local For index — otherwise every page looks flat.
    const globalDistance = () => {
      const globalIdx = local.messages.findIndex((item) => item.id === message.id)
      return Math.min(Math.abs(globalIdx - focusIndex()), 4)
    }

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
          data-distance={globalDistance()}
          aria-current={active() ? "step" : undefined}
          aria-label={`${index() + 1}. ${fallbackLabel(message)}`}
          onClick={() => {
            setActivePreview(undefined)
            setSuppressHover(true)
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

  const pagedMode = () => local.messages.length > MESSAGE_NAV_PAGE

  // Edge rows are the movers: the top slot selects the turn half a window
  // earlier, the bottom half a window later — the new selection lands centred,
  // so consecutive taps walk through history in even steps. Disabled once the
  // selection reaches that end of the session.
  const nudgeSelection = (dir: -1 | 1) => {
    const from = currentIndex()
    const target = Math.min(local.messages.length - 1, Math.max(0, from + dir * WINDOW_SLIDE))
    const message = local.messages[target]
    if (!message || target === from) return
    animateSlide(dir)
    setTimeout(() => selectMessage(message), SLIDE_ANIMATE_MS)
  }
  const pageMover = (dir: "prev" | "next") => {
    const delta = dir === "prev" ? -1 : 1
    const disabled =
      dir === "prev" ? currentIndex() <= 0 : currentIndex() >= local.messages.length - 1
    return (
      <li data-slot="message-nav-item">
        <button
          type="button"
          data-slot={`message-nav-page-${dir}`}
          disabled={disabled}
          aria-label={dir === "prev" ? "Earlier turns" : "Later turns"}
          onClick={() => nudgeSelection(delta)}
        >
          <span data-slot="message-nav-tick-line" />
        </button>
      </li>
    )
  }

  // Out-of-range slots (before turn 1 / after the last turn) render as inert,
  // near-invisible rows so the column keeps its shape at the session edges.
  const padRow = () => (
    <li data-slot="message-nav-item">
      <button type="button" data-slot="message-nav-pad" disabled tabIndex={-1} aria-hidden="true">
        <span data-slot="message-nav-tick-line" />
      </button>
    </li>
  )

  const compactRows = () => (
    <Index each={rowMessages()}>
      {(message, i) =>
        message() ? (
          <li data-slot="message-nav-item">{compactItem(message()!, () => clampedWindowStart() + i)}</li>
        ) : (
          padRow()
        )
      }
    </Index>
  )

  const normalRows = (items: readonly UserMessage[]) => (
    <For each={items}>
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
              data-slot="message-nav-message-button"
              data-message-id={message.id}
              onClick={handleClick}
              onKeyDown={handleKeyPress}
            >
              <DiffChanges changes={message.summary?.diffs ?? []} variant="bars" />
              <div data-slot="message-nav-title-preview" data-active={message.id === local.current?.id || undefined}>
                <Show when={local.getLabel?.(message) ?? message.summary?.title} fallback={i18n.t("ui.messageNav.newMessage")}>
                  {local.getLabel?.(message) ?? message.summary?.title}
                </Show>
              </div>
            </button>
          </li>
        )
      }}
    </For>
  )

  const content = (className?: string, items: readonly UserMessage[] = local.messages) => (
    <ul
      role="list"
      data-component="message-nav"
      data-size={local.size}
      class={className}
      style={
        local.size === "compact" && slide() !== 0
          ? {
              animation: `message-nav-slide-${
                slide() === -1 ? "older" : "newer"
              } ${SLIDE_ANIMATE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            }
          : { animation: undefined }
      }
      onAnimationEnd={() => setSlide(0)}
      {...others}
    >
      {local.size === "compact" && pagedMode() ? pageMover("prev") : null}
      {local.size === "compact" ? compactRows() : normalRows(items)}
      {local.size === "compact" && pagedMode() ? pageMover("next") : null}
    </ul>
  )

  return (
    <Show when={local.size === "normal" || local.messages.length > 10}>
      <Switch>
        <Match when={local.size === "compact"}>
          <div data-component="message-nav-hovercard">
            {content(undefined, rowMessages())}
          </div>
        </Match>
        <Match when={local.size === "normal"}>{content(local.class)}</Match>
      </Switch>
    </Show>
  )
}
