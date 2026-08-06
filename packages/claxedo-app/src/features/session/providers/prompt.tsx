import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type {
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2StoreInput,
  PromptInputV2StoreTuple,
} from "@/ui/session-kit"
import type { FileSelection } from "@/platform/files/types"
import { Persist, persisted } from "@/platform/persistence/persist"
import { checksum } from "@/lib/encode"
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
   * ABSOLUTE LOCAL FILESYSTEM PATH of the file this attachment was made from —
   * not a URL, and not the `@`-mention path a `FileAttachmentPart` carries (the
   * bytes already travel in `dataUrl`; this is only provenance).
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
   * DEAD ON READ TODAY: nothing in this repo consumes it. It is declared because
   * the writer is the contract — an undeclared field survives only by structural
   * accident and is dropped the moment a part is built through this type.
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
 * mutual assignability does NOT catch a field we forgot, because an object type
 * missing an OPTIONAL property is still assignable both ways. Key coverage does.
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
/**
 * How many prompt scopes the process-global cache retains. Exported so lifetime
 * tests can apply exactly the cap's worth of pressure instead of guessing at it.
 */
export const MAX_PROMPT_SESSIONS = 20
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

type PromptSession = ReturnType<typeof createPromptSession>

// Ref-counted LRU over directory/session scopes. Eviction DISPOSES the scope's
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

function value<T>(input: Accessor<T> | T): T {
  return typeof input === "function" ? (input as Accessor<T>)() : input
}

// ---------------------------------------------------------------------------
// T2.1 (plan 2026-07-25-005): raw per-scope draft tuple + scope identity.
//
// Everything below is ADDITIVE. `usePrompt()`'s pre-existing wrapped API is
// untouched; these exports sit beside it so upstream's v2 prompt-input
// controller (`createPromptInputV2Controller`) can bind its two structural
// inputs — `store` (an accessor returning a `[store, setStore]` Solid tuple)
// and `identity` (a value whose change reconciles the interaction machine back
// to its initial state) — without the composer reaching into module internals.
//
// This lives HERE rather than in `composer/v2/` because the app's orphan guard
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
 * `[accessor, setter]` in exactly the shape `createPromptInputV2Store` consumes
 * (upstream accepts `Store<T> | Accessor<Store<T>>` as element 0; we always
 * hand it the accessor form so reads stay reactive through the LRU).
 */
export type PromptDraftStoreTuple = [Accessor<PromptDraftState>, SetStoreFunction<PromptDraftState>]

/**
 * The stable per-scope handle. One object per prompt-cache entry, so its
 * reference identity IS the scope identity: it changes when (and only when) the
 * resolved scope changes, never when the draft inside it is edited. Mirrors
 * upstream's `prompt.capture()` (`upstream:packages/app/src/context/prompt-state.ts`).
 */
export type PromptDraftCapture = {
  readonly store: PromptDraftStoreTuple
}

/** The `Scope` accepted by `set`/`reset`/`capture`: RAW directory + RAW session id. */
export type PromptDraftScope = Scope

type Assert<T extends true> = T

/**
 * Machine-checked half of the shape reconciliation with upstream's view model:
 * our persisted draft is READ-compatible with `PromptInputV2PersistedState`.
 * If this ever stops holding, `Assert<false>` fails to compile right here.
 */
export type PromptDraftStateIsUpstreamReadable = Assert<
  PromptDraftState extends PromptInputV2PersistedState ? true : false
>

/**
 * Widen a Claxedo draft tuple to the tuple upstream's controller consumes.
 *
 * NO CAST — the assignment is fully checked (tripwired: making `PromptDraftState`
 * diverge produces TS2322 right on this return). Our draft is a strict subset of
 * `PromptInputV2PersistedState`; upstream declares optional fields we do not:
 *   - `model` — never written by `interaction.ts`/`machine.ts` (they only read
 *     `view.model`, a host-owned select control), so Claxedo keeping model and
 *     harness state outside the draft is not a conflict.
 *   - file-part `mime` / `filename` / `url` / `source` — not written by the
 *     controller either.
 *
 * Image-part `sourcePath` USED to be listed here as an upstream-only field. It is
 * not: it is written (see `ImageAttachmentPart#sourcePath`) and is now declared on
 * our side too, with `ImagePartDeclaresEveryUpstreamAttachmentField` keeping the
 * two key sets from drifting apart again.
 */
export function promptDraftStoreTuple(capture: PromptDraftCapture): PromptInputV2StoreTuple {
  return capture.store
}

/**
 * The two controller inputs for one scope, derived from a single `capture`
 * accessor so `store` and `identity` can never disagree about which scope they
 * describe. `identity` is the capture object itself, exactly as upstream wires
 * `identity: () => prompt.capture()`.
 *
 * The return type is annotated with upstream's OWN input types, so `tsgo` checks
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

  // The raw tuple, accessor-wrapped, created ONCE per scope so its reference
  // identity is stable for the life of this session. Additive: nothing that
  // already reads this session goes through it.
  const draftStore: PromptDraftStoreTuple = [() => store, setStore]

  return {
    ready,
    store: draftStore,
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

    // The MOUNTED scope's pin, and the ONLY long-lived one. `onCleanup` inside a
    // memo runs before every recompute AND on owner disposal, so the pin is
    // released on both ways out — a scope switch and provider teardown — with no
    // second bookkeeping structure to fall out of sync. Registered on the line
    // right after the acquire so no statement can throw in between; if `create()`
    // itself throws, the cache never admitted an entry, so there is nothing to
    // release.
    const session = createMemo(() => {
      const handle = acquire(
        promptScopeKey({
          dir: props.directory ? value(props.directory) : undefined,
          id: props.sessionId ? value(props.sessionId) : undefined,
          draftId: props.draftId ? value(props.draftId) : undefined,
        }),
        undefined,
      )
      onCleanup(handle.release)
      return handle.value
    })
    // A cross-session scope must resolve to the SAME prompt-cache/persist entry
    // the composer reads through `session()` — otherwise a scoped `set`/`reset`
    // (e.g. DialogFork restoring the forked message's draft into the new
    // session, or the submit path clearing the composer after send) writes to an
    // orphan entry the composer never mounts. BOTH `session()` and `withScope`
    // derive their key through the one canonical `promptScopeKey`, which applies
    // `sessionViewKey` exactly once. A `Scope` therefore carries the RAW
    // directory, session id, and draft id (mirroring `PromptProviderProps`); a
    // scope producer must never pre-compute the key or it double-wraps here.
    //
    // An explicit scope is BORROWED for the duration of the call only: pinning it
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
      // T2.1: the raw per-scope handle. Resolves through the SAME `withScope` the
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
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) =>
        withScope(scope, (target) => target.set(prompt, cursorPosition)),
      reset: (scope?: Scope) => withScope(scope, (target) => target.reset()),
    }
  },
}
export const { use: usePrompt, provider: PromptProvider } = createSimpleContext<ReturnType<typeof promptContextInput.init>, PromptProviderProps>(promptContextInput)
