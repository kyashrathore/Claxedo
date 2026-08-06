import { UserMessage } from "@opencode-ai/sdk/v2"
import { HoverCard } from "@kobalte/core/hover-card"
import { ComponentProps, For, Match, Show, createSignal, splitProps, Switch } from "solid-js"
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
    const preview = () => local.getPreview?.(message)
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
          data-active={active() || undefined}
          data-distance={Math.min(Math.abs(index() - focusIndex()), 4)}
          aria-current={active() ? "step" : undefined}
          aria-label={`${index() + 1}. ${user()}`}
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

  const content = (className?: string) => (
    <ul role="list" data-component="message-nav" data-size={local.size} class={className} {...others}>
      <For each={local.messages}>
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
                  <button data-slot="message-nav-message-button" onClick={handleClick} onKeyDown={handleKeyPress}>
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
    </ul>
  )

  return (
    <Show when={local.size === "normal" || local.messages.length > 10}>
      <Switch>
        <Match when={local.size === "compact"}>
          <div data-component="message-nav-hovercard" class={local.class}>
            {content()}
          </div>
        </Match>
        <Match when={local.size === "normal"}>{content(local.class)}</Match>
      </Switch>
    </Show>
  )
}
