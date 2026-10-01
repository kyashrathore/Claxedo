import { children, createMemo, createSignal, Show, type JSX } from "solid-js"
import type { AgentMessageAuthor } from "@claxedo/agent-runtime-contract"
import { messageAuthor } from "@/transcript"

type MessageWithAuthor = {
  role: string
  claxedo?: unknown
}

export function messageAuthorInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  const first = Array.from(words[0] ?? "")[0] ?? ""
  const last = words.length > 1 ? Array.from(words.at(-1) ?? "")[0] ?? "" : ""
  return (first + last).toUpperCase()
}

function MessageAuthorAvatar(props: { author: AgentMessageAuthor }) {
  const [failedImage, setFailedImage] = createSignal<string>()
  const initials = createMemo(() => messageAuthorInitials(props.author.name))
  const image = createMemo(() => failedImage() === props.author.avatarUrl ? undefined : props.author.avatarUrl)

  return (
    <div
      class="mt-1 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-weak-base bg-background-stronger text-[9px] font-medium leading-none text-text-strong"
      aria-label={props.author.name || "Message author"}
      title={props.author.name || undefined}
    >
      <Show
        when={image()}
        fallback={
          <Show
            when={initials()}
            fallback={
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                class="size-4 text-text-weak"
              >
                <circle cx="10" cy="7" r="3" fill="currentColor" />
                <path d="M4 17c.5-3.5 2.5-5 6-5s5.5 1.5 6 5" fill="currentColor" />
              </svg>
            }
          >
            <span aria-hidden="true">{initials()}</span>
          </Show>
        }
      >
        {(src) => (
          <img
            class="size-full object-cover"
            src={src()}
            alt={props.author.name || "Message author"}
            draggable={false}
            onError={() => setFailedImage(src())}
          />
        )}
      </Show>
    </div>
  )
}

export function MessageAuthorLane(props: { message: MessageWithAuthor; children: JSX.Element }) {
  const content = children(() => props.children)
  const author = createMemo(() => messageAuthor(props.message))

  return (
    <Show when={author()} fallback={content()}>
      {(author) => (
        <div class="flex w-full items-start justify-end gap-2">
          <div class="min-w-0 flex-1">{content()}</div>
          <MessageAuthorAvatar author={author()} />
        </div>
      )}
    </Show>
  )
}
