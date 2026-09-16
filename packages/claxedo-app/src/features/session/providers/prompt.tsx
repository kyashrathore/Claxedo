import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createMemo, createRoot, createSignal, createUniqueId, getOwner, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type {
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2StoreInput,
  PromptInputV2StoreTuple,
} from "@/ui/session-kit"
import type { FileSelection, SelectedLineRange } from "@/platform/files/types"
import { Persist, persisted, removePersisted } from "@/platform/persistence/persist"
import { checksum } from "@opencode-ai/ui/utils/encode"
import { useServer } from "@/features/session/app-ports"
import { createRefCountedLruResourceCache } from "@/platform/sync/live-resource-cache"
import { promptScopeKey } from "@/platform/identity/session-view-key"

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
  /**
   * The absolute local filesystem path of the file this attachment was made
   * from — not a URL, and not the `@`-mention path a `FileAttachmentPart`
   * carries (the bytes already travel in `dataUrl`; this is only provenance).
   *
   * Optional because only a host that can resolve a `File` back to a path
   * supplies one: the vendored v2 attachment writer
   * (`packages/session-ui/src/v2/components/prompt-input/attachments.ts:110`)
   * fills it from its `getPathForFile` config, which the desktop shell backs with
   * Electron's `webUtils.getPathForFile`
   * (`packages/claxedo-desktop/src/preload/index.ts:199`). In the browser, on a
   * clipboard image, and from Claxedo's own `composer/ui/attachments.ts`, there is
   * no path and the field is absent — the writer normalizes `""` to `undefined`.
   *
   * Nothing in this repo reads it yet. It is still declared because the writer
   * is the contract — an undeclared field survives only by structural accident
   * and is dropped the moment a part is built through this type.
   */
  sourcePath?: string
  mime: string
  dataUrl: string
}

/**
 * Upstream's image-attachment part. Extracted from the prompt union rather than
 * imported by name because `@/ui/session-kit` re-exports `PromptInputV2Prompt`
 * but not `PromptInputV2Attachment`, and the barrel is not this module's to widen.
 */
type UpstreamImageAttachment = Extract<PromptInputV2Prompt[number], { type: "image" }>

/**
 * Tripwire for the divergence that let `sourcePath` be written but not declared:
 * mutual assignability does not catch a field we forgot, because an object type
 * missing an optional property is still assignable both ways. Key coverage does.
 * Adding a field to upstream's attachment without mirroring it here fails to
 * compile right on this line instead of surviving as an undeclared runtime field.
 */
export type ImagePartDeclaresEveryUpstreamAttachmentField = Assert<
  keyof UpstreamImageAttachment extends keyof ImageAttachmentPart ? true : false
>

/** ...and the mirrored field must carry upstream's type, not merely its name. */
export type ImagePartSourcePathMatchesUpstream = Assert<
  ImageAttachmentPart["sourcePath"] extends UpstreamImageAttachment["sourcePath"] ? true : false
>


export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

/**
 * The queued message whose text the draft is holding: a send replaces that
 * message's parts instead of queueing another, and `cancel` gives the message
 * back to the queue untouched. Not persisted — the runtime's queue, not this
 * draft, decides whether the message still exists.
 */
export type QueuedMessageEdit = { seq: number; messageId?: string; cancel: () => void }

export type PromptHistoryComment = {
  id: string
  path: string
  selection: SelectedLineRange
  comment: string
  time: number
  origin?: "review" | "file"
  preview?: string
}

export type PromptHistoryEntry = {
  prompt: Prompt
  comments: PromptHistoryComment[]
}

/** Entries written before comments travelled with a prompt are a bare `Prompt`. */
export type PromptHistoryStoredEntry = Prompt | PromptHistoryEntry

export type PromptHistoryMode = "normal" | "shell"

export type PromptHistoryState = Record<PromptHistoryMode, PromptHistoryStoredEntry[]>

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
  return undefined
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
/**
 * How many prompt scopes the process-global cache retains. Exported so lifetime
 * tests can apply exactly the cap's worth of pressure instead of guessing at it.
 */
export const MAX_PROMPT_SESSIONS = 20
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

type PromptSession = ReturnType<typeof createPromptSession>

// Ref-counted LRU over directory/session scopes. Eviction disposes the scope's
// reactive root, so a plain LRU could dispose a scope a mounted composer is still
// subscribed to: `session()` is memoized on the provider's props, so it keeps
// handing out the same PromptSession object while its memos have been unsubscribed
// from the store underneath it — the draft silently stops updating. Pinning the
// scope a provider currently resolves to makes that unreachable; unpinned scopes
// stay cached (so switching away and back keeps the draft and the object identity
// upstream's controller uses as `identity`) and are still evicted under pressure,
// so MAX_PROMPT_SESSIONS keeps bounding retention.
const promptCache = createRefCountedLruResourceCache<PromptSession>(MAX_PROMPT_SESSIONS)

type Scope = {
  dir: string
  id?: string
  draftId?: string
}

type PromptProviderProps = {
  directory?: Accessor<string> | string
  sessionId?: Accessor<string | undefined> | string
  draftId?: Accessor<string | undefined> | string
}

/**
 * Read a prop that may be a plain value or an accessor.
 *
 * `T` is constrained to the string-ish props this provider actually takes, so
 * `typeof input === "function"` narrows to the accessor arm — an unconstrained
 * `T` could itself be a function, which is why this used to assert.
 */
function value<T extends string | undefined>(input: Accessor<T> | T): T {
  return typeof input === "function" ? input() : input
}

// ---------------------------------------------------------------------------
// Raw per-scope draft tuple + scope identity.
//
// Everything below is additive: `usePrompt()`'s pre-existing wrapped API is
// untouched; these exports sit beside it so upstream's v2 prompt-input
// controller (`createPromptInputV2Controller`) can bind its two structural
// inputs — `store` (an accessor returning a `[store, setStore]` Solid tuple)
// and `identity` (a value whose change reconciles the interaction machine back
// to its initial state) — without the composer reaching into module internals.
//
// This lives here rather than in `composer/v2/` because the app's orphan guard
// (`src/architecture/import-graph.guard.test.ts`) rejects production modules
// with no production consumer, and nothing wires the v2 controller yet. The
// bridge belongs to the draft-state owner anyway.
// ---------------------------------------------------------------------------

/** The shape actually persisted per scope. Named so the raw tuple can be typed. */
export type PromptDraftState = {
  prompt: Prompt
  cursor?: number
  context: {
    items: (ContextItem & { key: string })[]
  }
}

/**
 * `[accessor, setter]` in the shape `createPromptInputV2Store` consumes
 * (upstream accepts `Store<T> | Accessor<Store<T>>` as element 0; we always
 * hand it the accessor form so reads stay reactive through the LRU).
 */
export type PromptDraftStoreTuple = [Accessor<PromptDraftState>, SetStoreFunction<PromptDraftState>]

/**
 * The stable per-scope handle. One object per prompt-cache entry, so its
 * reference identity is the scope identity: it changes when (and only when) the
 * resolved scope changes, never when the draft inside it is edited. Mirrors
 * upstream's `prompt.capture()` (`upstream:packages/app/src/context/prompt-state.ts`).
 */
export type PromptDraftCapture = {
  readonly store: PromptDraftStoreTuple
}

/** The `Scope` accepted by `set`/`reset`/`capture`: raw directory + raw session id. */
export type PromptDraftScope = Scope

type Assert<T extends true> = T

/**
 * Machine-checked half of the shape reconciliation with upstream's view model:
 * our persisted draft is read-compatible with `PromptInputV2PersistedState`.
 * If this ever stops holding, `Assert<false>` fails to compile right here.
 */
export type PromptDraftStateIsUpstreamReadable = Assert<
  PromptDraftState extends PromptInputV2PersistedState ? true : false
>

/**
 * Widen a Claxedo draft tuple to the tuple upstream's controller consumes.
 *
 * No cast: the assignment is fully checked (tripwired — making `PromptDraftState`
 * diverge produces TS2322 right on this return). Our draft is a strict subset of
 * `PromptInputV2PersistedState`; upstream declares optional fields we do not:
 *   - `model` — never written by `interaction.ts`/`machine.ts` (they only read
 *     `view.model`, a host-owned select control), so Claxedo keeping model and
 *     harness state outside the draft is not a conflict.
 *   - file-part `mime` / `filename` / `url` / `source` — not written by the
 *     controller either.
 *
 * Image-part `sourcePath` is written (see `ImageAttachmentPart#sourcePath`) and
 * declared on our side too; `ImagePartDeclaresEveryUpstreamAttachmentField` keeps
 * the two key sets from drifting apart.
 */
export function promptDraftStoreTuple(capture: PromptDraftCapture): PromptInputV2StoreTuple {
  return capture.store
}

/**
 * The two controller inputs for one scope, derived from a single `capture`
 * accessor so `store` and `identity` can never disagree about which scope they
 * describe. `identity` is the capture object itself, the same way upstream wires
 * `identity: () => prompt.capture()`.
 *
 * The return type is annotated with upstream's own input types, so `tsgo` checks
 * this against `PromptInputV2ControllerInput` rather than us asserting it.
 */
export function promptDraftControllerInput(capture: Accessor<PromptDraftCapture>): {
  store: PromptInputV2StoreInput
  identity: Accessor<unknown>
} {
  return {
    store: () => promptDraftStoreTuple(capture()),
    identity: () => capture(),
  }
}

function createPromptSession(serverUrl: string, dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`
  const [goalArmed, setGoalArmed] = createSignal(false)
  const [queuedEdit, setQueuedEdit] = createSignal<QueuedMessageEdit>()

  const [store, setStore, _, ready] = persisted(
    SERVER_SCOPED_PERSIST
      ? Persist.serverScoped(serverUrl, dir, id, "prompt", [legacy])
      : Persist.scoped(dir, id, "prompt", [legacy]),
    createStore<PromptDraftState>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
    }),
  )

  const [history, setHistory] = persisted(
    SERVER_SCOPED_PERSIST
      ? Persist.serverScoped(serverUrl, dir, id, "prompt-history")
      : Persist.scoped(dir, id, "prompt-history"),
    createStore<PromptHistoryState>({ normal: [], shell: [] }),
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

  // The raw tuple, accessor-wrapped, created once per scope so its reference
  // identity is stable for the life of this session. Additive: nothing that
  // already reads this session goes through it.
  const draftStore: PromptDraftStoreTuple = [() => store, setStore]

  return {
    ready,
    store: draftStore,
    current: createMemo(() => store.prompt),
    cursor: createMemo(() => store.cursor),
    dirty: createMemo(() => !isPromptEqual(store.prompt, DEFAULT_PROMPT)),
    goal: {
      armed: goalArmed,
      setArmed: setGoalArmed,
    },
    queuedEdit: {
      current: queuedEdit,
      set: setQueuedEdit,
    },
    history: {
      entries(mode: PromptHistoryMode) {
        return history[mode]
      },
      replace(mode: PromptHistoryMode, entries: PromptHistoryStoredEntry[]) {
        setHistory(mode, entries)
      },
    },
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

// Entries under the global keys name no session, so no session's history can
// claim them; they are deleted, not migrated.
let globalPromptHistoryDropped = false
function dropGlobalPromptHistory() {
  if (globalPromptHistoryDropped) return
  globalPromptHistoryDropped = true
  void removePersisted(Persist.global("prompt-history"))
  void removePersisted(Persist.global("prompt-history-shell"))
}

const promptContextInput = {
  name: "Prompt",
  gate: false,
  init: (props: PromptProviderProps) => {
    const server = useServer()
    const owner = getOwner()
    dropGlobalPromptHistory()
    const acquire = (dir: string, id: string | undefined) => {
      const key = SERVER_SCOPED_PERSIST
        ? `${server.url}:${dir}:${id ?? WORKSPACE_KEY}`
        : `${dir}:${id ?? WORKSPACE_KEY}`
      return promptCache.acquire(key, () =>
        createRoot(
          (dispose) => ({
            value: createPromptSession(server.url, dir, id),
            dispose,
          }),
          owner,
        ),
      )
    }

    // A composer whose pane names neither a session nor a surface still owns a
    // draft of its own. Without an id minted here its scope falls back to the
    // directory, and every such composer in that directory reads and writes one
    // shared draft — an image attached in one appears in the next. A real session
    // id outranks it in `promptScopeKey`, so the minted id only ever names the
    // drafts nothing else names.
    const ownDraftId = createUniqueId()
    const mountedScope = createMemo<Scope>(() => ({
      dir: (props.directory ? value(props.directory) : undefined) ?? "",
      id: props.sessionId ? value(props.sessionId) : undefined,
      draftId: (props.draftId ? value(props.draftId) : undefined) ?? ownDraftId,
    }))

    // The mounted scope's pin, and the only long-lived one. `onCleanup` inside a
    // memo runs before every recompute and on owner disposal, so the pin is
    // released on both ways out — a scope switch and provider teardown — with no
    // second bookkeeping structure to fall out of sync. Registered on the line
    // right after the acquire so no statement can throw in between; if `create()`
    // itself throws, the cache never admitted an entry, so there is nothing to
    // release.
    const session = createMemo(() => {
      const handle = acquire(promptScopeKey(mountedScope()), undefined)
      onCleanup(handle.release)
      return handle.value
    })
    // A cross-session scope must resolve to the same prompt-cache/persist entry
    // the composer reads through `session()` — otherwise a scoped `set`/`reset`
    // (e.g. DialogFork restoring the forked message's draft into the new
    // session, or the submit path clearing the composer after send) writes to an
    // orphan entry the composer never mounts. Both `session()` and `withScope`
    // derive their key through the one canonical `promptScopeKey`, which applies
    // `sessionViewKey` exactly once. A `Scope` therefore carries the raw
    // directory, session id, and draft id (mirroring `PromptProviderProps`); a
    // scope producer must never pre-compute the key or it double-wraps here.
    //
    // An explicit scope is borrowed for the duration of the call only: pinning it
    // past that would make the entry immortal, and a leaked pin is worse than the
    // eviction this replaces. `finally` so a throwing writer cannot leak one. The
    // release does not dispose, so the write is still there when the composer
    // later mounts that scope.
    const withScope = <R,>(scope: Scope | undefined, use: (session: PromptSession) => R): R => {
      if (!scope) return use(session())
      const handle = acquire(promptScopeKey({ dir: scope.dir, id: scope.id, draftId: scope.draftId }), undefined)
      try {
        return use(handle.value)
      } finally {
        handle.release()
      }
    }

    return {
      ready: () => session().ready(),
      // The draft this provider is mounted on, as a value. A writer that resumes
      // after an `await`, and the post-submit clear, both have to reach the draft
      // the user was typing into rather than whichever one the pane resolves by
      // the time they run; re-deriving it from their own props drifts off this
      // one the moment either side changes.
      scope: (): Scope => ({ ...mountedScope() }),
      // The raw per-scope handle. Resolves through the same `withScope` the
      // scoped `set`/`reset` use, so a controller bound here and a scoped clear
      // can never target different prompt-cache entries. Reference-stable per
      // scope (one object per cache entry), which is what makes it usable as
      // upstream's `identity`. Reading it tracks `session()` when no explicit
      // scope is passed, so a scope switch notifies — and that no-scope form is
      // the only one a long-lived consumer may hold, since it is the pinned one.
      // With an explicit scope the returned handle outlives the borrow and can
      // still be evicted; no caller does that today (`controller-engine.ts` binds
      // `capture()` with no argument).
      capture: (scope?: Scope): PromptDraftCapture => withScope(scope, (target) => target),
      current: (scope?: Scope) => withScope(scope, (target) => target.current()),
      cursor: (scope?: Scope) => withScope(scope, (target) => target.cursor()),
      dirty: () => session().dirty(),
      goal: {
        armed: () => session().goal.armed(),
        setArmed: (armed: boolean) => session().goal.setArmed(armed),
      },
      queuedEdit: {
        current: () => session().queuedEdit.current(),
        set: (edit: QueuedMessageEdit | undefined) => session().queuedEdit.set(edit),
      },
      // Recall reads the mounted draft's own sends. A write may name the scope
      // because a first send happens from a `draft:` scope and belongs to the
      // session it creates, which is only known once the send has resolved.
      history: {
        entries: (mode: PromptHistoryMode, scope?: Scope) =>
          withScope(scope, (target) => target.history.entries(mode)),
        replace: (mode: PromptHistoryMode, entries: PromptHistoryStoredEntry[], scope?: Scope) =>
          withScope(scope, (target) => target.history.replace(mode, entries)),
      },
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
        removeComment: (path: string, commentID: string) => session().context.removeComment(path, commentID),
        updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
          session().context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[]) => session().context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) =>
        withScope(scope, (target) => target.set(prompt, cursorPosition)),
      reset: (scope?: Scope) => withScope(scope, (target) => target.reset()),
    }
  },
}
export const { use: usePrompt, provider: PromptProvider } = createSimpleContext<ReturnType<typeof promptContextInput.init>, PromptProviderProps>(promptContextInput)
