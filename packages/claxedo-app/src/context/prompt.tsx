import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createMemo, createRoot, getOwner } from "solid-js"
import type { Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { Persist, persisted } from "@/utils/persist"
import { checksum } from "@claxedo/utils/encode"
import { useServer } from "@/context/server"
import { createLruResourceCache } from "@/context/live-resource-cache"
import { sessionViewKey } from "../shell/identity/session-view-key"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
}

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

type PromptSession = ReturnType<typeof createPromptSession>

// LRU over the newest MAX_PROMPT_SESSIONS directory/session scopes; evicted
// scopes have their reactive root disposed.
const promptCache = createLruResourceCache<PromptSession>(MAX_PROMPT_SESSIONS)

type Scope = {
  dir: string
  id?: string
}

type PromptProviderProps = {
  directory?: Accessor<string> | string
  sessionId?: Accessor<string | undefined> | string
}

function value<T>(input: Accessor<T> | T): T {
  return typeof input === "function" ? (input as Accessor<T>)() : input
}

function createPromptSession(serverUrl: string, dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`

  const [store, setStore, _, ready] = persisted(
    SERVER_SCOPED_PERSIST
      ? Persist.serverScoped(serverUrl, dir, id, "prompt", [legacy])
      : Persist.scoped(dir, id, "prompt", [legacy]),
    createStore<{
      prompt: Prompt
      cursor?: number
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
    }),
  )

  function keyForItem(item: ContextItem) {
    if (item.type !== "file") return item.type
    const start = item.selection?.startLine
    const end = item.selection?.endLine
    const key = `${item.type}:${item.path}:${start}:${end}`

    if (item.commentID) {
      return `${key}:c=${item.commentID}`
    }

    const comment = item.comment?.trim()
    if (!comment) return key
    const digest = checksum(comment) ?? comment
    return `${key}:c=${digest.slice(0, 8)}`
  }

  return {
    ready,
    current: createMemo(() => store.prompt),
    cursor: createMemo(() => store.cursor),
    dirty: createMemo(() => !isPromptEqual(store.prompt, DEFAULT_PROMPT)),
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = keyForItem(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: keyForItem(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !(item.type === "file" && !!item.comment?.trim())),
          ...items.map((item) => ({ ...item, key: keyForItem(item) })),
        ])
      },
    },
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const promptContextInput = {
  name: "Prompt",
  gate: false,
  init: (props: PromptProviderProps) => {
    const server = useServer()
    const owner = getOwner()
    const load = (dir: string, id: string | undefined) => {
      const key = SERVER_SCOPED_PERSIST
        ? `${server.url}:${dir}:${id ?? WORKSPACE_KEY}`
        : `${dir}:${id ?? WORKSPACE_KEY}`
      return promptCache.load(key, () =>
        createRoot(
          (dispose) => ({
            value: createPromptSession(server.url, dir, id),
            dispose,
          }),
          owner,
        ),
      )
    }

    const session = createMemo(() =>
      load(
        sessionViewKey({
          directory: props.directory ? value(props.directory) : undefined,
          sessionId: props.sessionId ? value(props.sessionId) : undefined,
        }),
        undefined,
      ),
    )
    // A cross-session scope must resolve to the SAME prompt-cache/persist entry
    // the composer reads through `session()` — otherwise a scoped `set`/`reset`
    // (e.g. DialogFork restoring the forked message's draft into the new
    // session) writes to an orphan entry the composer never mounts. `session()`
    // keys on `sessionViewKey(...)`, so `pick` must derive the key the same way
    // instead of the raw `load(dir, id)` it used before the session-view-key
    // refactor. Scope carries the raw directory + session id, mirroring
    // `PromptProviderProps`.
    const pick = (scope?: Scope) =>
      scope ? load(sessionViewKey({ directory: scope.dir, sessionId: scope.id }), undefined) : session()

    return {
      ready: () => session().ready(),
      current: () => session().current(),
      cursor: () => session().cursor(),
      dirty: () => session().dirty(),
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
        removeComment: (path: string, commentID: string) => session().context.removeComment(path, commentID),
        updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
          session().context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[]) => session().context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: Scope) => pick(scope).reset(),
    }
  },
}
export const { use: usePrompt, provider: PromptProvider } = createSimpleContext<ReturnType<typeof promptContextInput.init>, PromptProviderProps>(promptContextInput)
