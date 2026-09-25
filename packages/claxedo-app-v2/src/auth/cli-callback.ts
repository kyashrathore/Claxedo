import { preferenceKey, tabStorage } from "@/lib/persisted"

export const CLI_CALLBACK_DOCUMENT = "/cli-callback.html"

const HANDOFF_KEY = preferenceKey("cli-callback")

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"])

export type CliCallback = { readonly callback: string; readonly fields: Readonly<Record<string, string>> }

export class CliCallbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliCallbackError"
  }
}

export function localCallback(input: string | null): string | undefined {
  if (!input || !URL.canParse(input)) return undefined
  const url = new URL(input)
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return undefined
  return url.toString()
}

function storage(): Storage {
  const tab = tabStorage()
  if (!tab) throw new CliCallbackError("This browser keeps no tab storage, so the CLI sign-in cannot be handed off.")
  return tab
}

function readFields(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  return entries.every(([, field]) => typeof field === "string") ? Object.fromEntries(entries) : undefined
}

function readHandoff(text: string): CliCallback | undefined {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null) return undefined
  const callback = localCallback(typeof (parsed as { callback?: unknown }).callback === "string" ? (parsed as { callback: string }).callback : null)
  const fields = readFields((parsed as { fields?: unknown }).fields)
  return callback && fields ? { callback, fields } : undefined
}

export function handOffCliCallback(handoff: CliCallback, navigate: (path: string) => void, tab: Storage = storage()): void {
  tab.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  navigate(CLI_CALLBACK_DOCUMENT)
}

export function takeCliCallback(tab: Storage = storage()): CliCallback | undefined {
  const text = tab.getItem(HANDOFF_KEY)
  tab.removeItem(HANDOFF_KEY)
  return text === null ? undefined : readHandoff(text)
}

export function submitCliCallback(target: Document, handoff: CliCallback): void {
  const form = target.createElement("form")
  form.method = "POST"
  form.action = handoff.callback
  form.hidden = true
  for (const [name, value] of Object.entries(handoff.fields)) {
    const field = target.createElement("input")
    field.type = "hidden"
    field.name = name
    field.value = value
    form.appendChild(field)
  }
  target.body.appendChild(form)
  form.submit()
}
