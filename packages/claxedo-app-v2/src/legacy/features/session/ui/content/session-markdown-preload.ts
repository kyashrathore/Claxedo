import { preloadMarkdown } from "@/ui/session-kit-loaders"
import { SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT } from "@/platform/sync/session-prefetch"

type MarkdownTextPart = {
  type: string
  text?: string
  id?: string
}

export type SessionMarkdownBody = {
  text: string
  cacheKey: string
}

export type SessionMarkdownMessage = {
  id: string
  role?: string
  time?: { completed?: number; created?: number }
  error?: unknown
}

export type SessionMarkdownTimelineGate = "blocked" | "live" | "preload"

function firstFoldMessages<T>(messages: T[]) {
  return messages.slice(-SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT)
}

export function assistantMessageIsLive(message: SessionMarkdownMessage) {
  if (message.role !== "assistant") return false
  if (typeof message.time?.completed === "number") return false
  if (message.error) return false
  return true
}

/**
 * Stable across streaming tokens: message ids and settled/live, not part text.
 * The timeline preload gate must not retrigger on every delta.
 */
export function firstFoldMarkdownPreloadIdentity(messages: SessionMarkdownMessage[]) {
  return firstFoldMessages(messages)
    .map((message) => `${message.id}:${assistantMessageIsLive(message) ? "live" : "settled"}`)
    .join("|")
}

export function firstFoldMarkdownIdentityIsLive(identity: string) {
  if (!identity) return false
  return identity.split("|").some((part) => part.endsWith(":live"))
}

export function sessionMarkdownTimelineGate(input: {
  messagesReady: boolean
  sessionKey: string | undefined
  firstFoldIdentity: string
}): SessionMarkdownTimelineGate {
  if (!input.messagesReady || !input.sessionKey) return "blocked"
  if (firstFoldMarkdownIdentityIsLive(input.firstFoldIdentity)) return "live"
  return "preload"
}

export function firstFoldMarkdownBodies(input: {
  messages: SessionMarkdownMessage[]
  parts: Record<string, MarkdownTextPart[] | undefined>
}): SessionMarkdownBody[] {
  const bodies: SessionMarkdownBody[] = []
  for (const message of firstFoldMessages(input.messages)) {
    if (assistantMessageIsLive(message)) continue
    for (const part of input.parts[message.id] ?? []) {
      if (part.type !== "text" || !part.text || !part.id) continue
      bodies.push({ text: part.text, cacheKey: part.id })
    }
  }
  return bodies
}

export async function preloadSessionMarkdownBodies(
  bodies: SessionMarkdownBody[],
  parser: { parse(text: string): string | Promise<string> },
) {
  if (bodies.length === 0) return
  await Promise.all(bodies.map((body) => preloadMarkdown(body.text, body.cacheKey, parser)))
}
