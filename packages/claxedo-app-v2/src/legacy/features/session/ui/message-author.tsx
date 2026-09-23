import { children, createMemo, createSignal, Show, type JSX } from "solid-js"
import type { ClaxedoMessageAuthor } from "@claxedo/agent-event-runtime/client-presentation"
import { asRecord } from "@/lib/record"

type MessageWithAuthor = {
  role: string
  claxedo?: unknown
}

export function messageAuthor(message: MessageWithAuthor): ClaxedoMessageAuthor | undefined {
  if (message.role !== "user") return undefined
  const author = asRecord(asRecord(message.claxedo)?.author)
  if (!author) return undefined
  if (typeof author.id !== "string" || typeof author.name !== "string") return undefined
  if (author.kind !== "human" && author.kind !== "agent") return undefined
  return {
    id: author.id,
    name: author.name,
    ...(typeof author.avatarUrl === "string" && author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
    kind: author.kind,
  }
}

export function messageAuthorInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  const first = Array.from(words[0] ?? "")[0] ?? ""
  const last = words.length > 1 ? Array.from(words.at(-1) ?? "")[0] ?? "" : ""
  return (first + last).toUpperCase()
}

export function MessageAuthorAvatar(props: { author: ClaxedoMessageAuthor }) {
  const [failedImage, setFailedImage] = createSignal<string>()
  const initials = createMemo(() => messageAuthorInitials(props.author.name))
  const image = createMemo(() => failedImage() === props.author.avatarUrl ? undefined : props.author.avatarUrl)

  return (
    <div
      data-component="message-author-avatar"
      class="mt-1 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-weak-base bg-background-stronger text-11-medium text-text-strong"
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
                data-slot="message-author-generic"
                aria-hidden="true"
                viewBox="0 0 20 20"
                class="size-4 text-text-weak"
              >
                <circle cx="10" cy="7" r="3" fill="currentColor" />
                <path d="M4 17c.5-3.5 2.5-5 6-5s5.5 1.5 6 5" fill="currentColor" />
              </svg>
            }
          >
            <span data-slot="message-author-initials" aria-hidden="true">{initials()}</span>
          </Show>
        }
      >
        {(src) => (
          <img
            data-slot="message-author-image"
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
        <div data-slot="message-author-lane" class="flex w-full items-start justify-end gap-2">
          <div data-slot="message-author-content" class="min-w-0 flex-1">{content()}</div>
          <div data-slot="message-author-meta" class="flex shrink-0 flex-col items-center gap-1">
            <MessageAuthorAvatar author={author()} />
            <Show when={author().name.trim()}>
              <span
                data-slot="message-author-name"
                class="max-w-[4.75rem] truncate text-center text-11-regular text-text-weak"
                title={author().name}
              >
                {author().name}
              </span>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
