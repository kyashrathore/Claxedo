/**
 * Pane Communication Bus
 *
 * Unified pub/sub for routing messages between panes in a tab's
 * multi-pane layout. Replaces ad-hoc channels (comment-channel,
 * review-context-channel) with a single bus that any pane can plug into.
 *
 * Panes register with capabilities and handlers. The bus supports:
 * - Pane-to-pane messaging (comments, context toggles)
 * - Directed 1:1 bindings (review→session for comments)
 * - Server-initiated actions via dispatch()
 * - Reactive peer discovery (SolidJS signals)
 */

import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommentPayload = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

/**
 * Payload produced by the browser pane when the user comments on a selected
 * DOM element. Intentionally disjoint from `CommentPayload` so the
 * `page-comment:*` capability pair never cross-delivers to review-only
 * `comment:receive` consumers.
 *
 * The consumer is expected to store this into the claxedo-owned
 * `useBrowserComments` store keyed by its own session id — the producer
 * doesn't know the session id.
 */
export type PageElementCommentPayload = {
  tabId: string
  pageUrl: string
  selector: string
  comment: string
  noteText: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  outerHTML?: string
  screenshotDataUrl?: string
}

export type ModelKey = { providerID: string; modelID: string }

export type PaneCapability =
  | "comment:receive"
  | "comment:produce"
  | "context:toggle"
  | "page-ai:receive"
  | "model:provide"
  | "session:provide"
  | "review:focus-file"
  | "page-comment:produce"
  | "page-comment:receive"

export type PaneHandlerMap = {
  "comment:receive"?: {
    onComment: (payload: CommentPayload) => void
    onRemove?: (path: string, commentID: string) => void
    onClear?: () => void
  }
  "comment:produce"?: {
    onRemoveFromConsumer?: (path: string, commentID: string) => void
  }
  "context:toggle"?: (sessionId?: string) => void
  "page-ai:receive"?: {
    onAction: (action: string, instruction?: string) => void
    onOpen: () => void
  }
  "model:provide"?: () => ModelKey | undefined
  "session:provide"?: () => string | undefined
  "review:focus-file"?: {
    onFocusFile: (path: string) => void
  }
  "page-comment:produce"?: Record<string, never>
  "page-comment:receive"?: {
    onPageComment: (payload: PageElementCommentPayload) => void
  }
}

export type PaneRegistration = {
  leafId: string
  tabId: string
  type: string
  name: Accessor<string>
  capabilities: PaneCapability[]
  handlers: PaneHandlerMap
  onAction?: (action: PaneAction) => void
}

export type BindingType = "comment" | "review" | "page-comment"

export type PaneAction =
  | { type: "comment:add"; payload: CommentPayload }
  | { type: "comment:remove"; payload: { path: string; commentID: string } }
  | { type: "comment:clear" }
  | { type: "context:toggle"; payload: { sessionId?: string } }
  | { type: "page-ai:action"; payload: { action: string; instruction?: string } }
  | { type: "page-ai:open" }
  | { type: "review:focus-file"; payload: { path: string } }
  | { type: "page-comment:add"; payload: PageElementCommentPayload }
  | { type: "custom"; channel: string; payload: unknown }

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

type BusState = {
  panes: Map<string, PaneRegistration>
  bindings: Map<string, Map<string, string>> // bindingType -> (fromLeafId -> toLeafId)
}

const state: BusState = {
  panes: new Map(),
  bindings: new Map(),
}

const [version, setVersion] = createSignal(0)

function bump() {
  setVersion((v) => v + 1)
}

function getBindingMap(type: BindingType): Map<string, string> {
  let m = state.bindings.get(type)
  if (!m) {
    m = new Map()
    state.bindings.set(type, m)
  }
  return m
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(reg: PaneRegistration): () => void {
  state.panes.set(reg.leafId, reg)
  bump()
  return () => {
    state.panes.delete(reg.leafId)
    // Clean up bindings where this pane is source or target
    for (const bMap of state.bindings.values()) {
      // Remove as source
      bMap.delete(reg.leafId)
      // Remove as target
      for (const [from, to] of bMap) {
        if (to === reg.leafId) bMap.delete(from)
      }
    }
    bump()
  }
}

/**
 * SolidJS hook — registers a pane and auto-cleans up on disposal.
 */
export function usePane(reg: PaneRegistration): void {
  let cleanup: (() => void) | undefined
  createEffect(() => {
    cleanup?.()
    // Track reactive name so re-registration happens on name change
    reg.name()
    cleanup = register(reg)
  })
  onCleanup(() => cleanup?.())
}

/**
 * Convenience hook for session/terminal panes that receive comments.
 */
export function useCommentReceiver(input: {
  leafId: string
  tabId: string
  type: string
  name: Accessor<string>
  onComment: (payload: CommentPayload) => void
  onRemove?: (path: string, commentID: string) => void
  onClear?: () => void
}): void {
  usePane({
    leafId: input.leafId,
    tabId: input.tabId,
    type: input.type,
    name: input.name,
    capabilities: ["comment:receive"],
    handlers: {
      "comment:receive": {
        onComment: input.onComment,
        onRemove: input.onRemove,
        onClear: input.onClear,
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Peer Discovery (reactive)
// ---------------------------------------------------------------------------

export function getPane(leafId: string): PaneRegistration | undefined {
  version()
  return state.panes.get(leafId)
}

export function peers(tabId: string): PaneRegistration[] {
  version()
  const result: PaneRegistration[] = []
  for (const reg of state.panes.values()) {
    if (reg.tabId === tabId) result.push(reg)
  }
  return result
}

export function peersWithCapability(capability: PaneCapability, tabId: string): PaneRegistration[] {
  version()
  const result: PaneRegistration[] = []
  for (const reg of state.panes.values()) {
    if (reg.tabId === tabId && reg.capabilities.includes(capability)) {
      result.push(reg)
    }
  }
  return result
}

export function siblings(leafId: string): PaneRegistration[] {
  version()
  const self = state.panes.get(leafId)
  if (!self) return []
  const result: PaneRegistration[] = []
  for (const reg of state.panes.values()) {
    if (reg.tabId === self.tabId && reg.leafId !== leafId) {
      result.push(reg)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Bindings (1:1 directed links)
// ---------------------------------------------------------------------------

export function bind(type: BindingType, fromLeafId: string, toLeafId: string): void {
  getBindingMap(type).set(fromLeafId, toLeafId)
  bump()
}

export function unbind(type: BindingType, fromLeafId: string): void {
  const m = state.bindings.get(type)
  if (m) {
    m.delete(fromLeafId)
    bump()
  }
}

export function getBound(type: BindingType, fromLeafId: string): string | null {
  version()
  return state.bindings.get(type)?.get(fromLeafId) ?? null
}

export function getBoundSources(type: BindingType, toLeafId: string): string[] {
  version()
  const m = state.bindings.get(type)
  if (!m) return []
  const result: string[] = []
  for (const [from, to] of m) {
    if (to === toLeafId) result.push(from)
  }
  return result
}

/**
 * Heuristic auto-bind: if the producer has no binding and exactly one
 * pane in the same tab has the target capability, bind to it.
 */
export function autoBind(
  producerLeafId: string,
  type: BindingType,
  targetCapability: PaneCapability,
): void {
  const m = getBindingMap(type)
  if (m.has(producerLeafId)) return

  const producer = state.panes.get(producerLeafId)
  if (!producer) return

  const candidates: PaneRegistration[] = []
  for (const reg of state.panes.values()) {
    if (reg.tabId === producer.tabId && reg.leafId !== producerLeafId && reg.capabilities.includes(targetCapability)) {
      candidates.push(reg)
    }
  }

  if (candidates.length === 1) {
    m.set(producerLeafId, candidates[0].leafId)
    bump()
  }
}

// ---------------------------------------------------------------------------
// Pane-to-Pane Messaging
// ---------------------------------------------------------------------------

export function sendComment(fromLeafId: string, payload: CommentPayload): boolean {
  const toLeafId = getBindingMap("comment").get(fromLeafId)
  if (!toLeafId) return false
  const target = state.panes.get(toLeafId)
  if (!target) return false
  target.handlers["comment:receive"]?.onComment(payload)
  return true
}

export function sendCommentRemoval(fromLeafId: string, path: string, commentID: string): boolean {
  const toLeafId = getBindingMap("comment").get(fromLeafId)
  if (!toLeafId) return false
  const target = state.panes.get(toLeafId)
  if (!target) return false
  target.handlers["comment:receive"]?.onRemove?.(path, commentID)
  return true
}

export function sendCommentClear(fromLeafId: string): void {
  const toLeafId = getBindingMap("comment").get(fromLeafId)
  if (!toLeafId) return
  const target = state.panes.get(toLeafId)
  if (!target) return
  target.handlers["comment:receive"]?.onClear?.()
}

/**
 * Reverse direction: consumer→producer. Notifies all producers
 * bound to this consumer that a comment was removed.
 */
export function notifyProducerRemoval(consumerLeafId: string, path: string, commentID: string): void {
  const m = state.bindings.get("comment")
  if (!m) return
  for (const [producerLeafId, targetLeafId] of m) {
    if (targetLeafId === consumerLeafId) {
      const producer = state.panes.get(producerLeafId)
      producer?.handlers["comment:produce"]?.onRemoveFromConsumer?.(path, commentID)
    }
  }
}

export function sendFocusFile(tabId: string, path: string): number {
  return dispatchToCapability(tabId, "review:focus-file", {
    type: "review:focus-file",
    payload: { path },
  })
}

/**
 * Route a page-element comment from a browser producer to its bound session
 * consumer. Mirrors `sendComment`, but uses the `"page-comment"` binding
 * type so consumers that only registered `comment:receive` never see these
 * payloads.
 */
export function sendPageComment(fromLeafId: string, payload: PageElementCommentPayload): boolean {
  const toLeafId = getBindingMap("page-comment").get(fromLeafId)
  if (!toLeafId) return false
  const target = state.panes.get(toLeafId)
  if (!target) return false
  const handler = target.handlers["page-comment:receive"]
  if (!handler) return false
  handler.onPageComment(payload)
  return true
}

export function sendContextToggle(leafId: string, sessionId?: string): boolean {
  const target = state.panes.get(leafId)
  if (!target) return false
  const handler = target.handlers["context:toggle"]
  if (!handler) return false
  handler(sessionId)
  return true
}

// ---------------------------------------------------------------------------
// Server-Initiated Actions
// ---------------------------------------------------------------------------

export function dispatch(leafId: string, action: PaneAction): boolean {
  const target = state.panes.get(leafId)
  if (!target) return false

  // Try custom onAction handler first
  if (target.onAction) {
    target.onAction(action)
    return true
  }

  // Route to standard handlers
  switch (action.type) {
    case "comment:add": {
      const h = target.handlers["comment:receive"]
      if (!h) return false
      h.onComment(action.payload)
      return true
    }
    case "comment:remove": {
      const h = target.handlers["comment:receive"]
      if (!h) return false
      h.onRemove?.(action.payload.path, action.payload.commentID)
      return true
    }
    case "comment:clear": {
      const h = target.handlers["comment:receive"]
      if (!h) return false
      h.onClear?.()
      return true
    }
    case "context:toggle": {
      const h = target.handlers["context:toggle"]
      if (!h) return false
      h(action.payload.sessionId)
      return true
    }
    case "page-ai:action": {
      const h = target.handlers["page-ai:receive"]
      if (!h) return false
      h.onAction(action.payload.action, action.payload.instruction)
      return true
    }
    case "page-ai:open": {
      const h = target.handlers["page-ai:receive"]
      if (!h) return false
      h.onOpen()
      return true
    }
    case "review:focus-file": {
      const h = target.handlers["review:focus-file"]
      if (!h) return false
      h.onFocusFile(action.payload.path)
      return true
    }
    case "page-comment:add": {
      const h = target.handlers["page-comment:receive"]
      if (!h) return false
      h.onPageComment(action.payload)
      return true
    }
    case "custom":
      return false
  }
}

export function dispatchToCapability(tabId: string, capability: PaneCapability, action: PaneAction): number {
  let count = 0
  for (const reg of state.panes.values()) {
    if (reg.tabId !== tabId || !reg.capabilities.includes(capability)) continue
    if (dispatch(reg.leafId, action)) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Page AI Messaging
// ---------------------------------------------------------------------------

export function sendPageAiAction(tabId: string, action: string, instruction?: string): number {
  return dispatchToCapability(tabId, "page-ai:receive", {
    type: "page-ai:action",
    payload: { action, instruction },
  })
}

export function sendPageAiOpen(tabId: string): number {
  return dispatchToCapability(tabId, "page-ai:receive", { type: "page-ai:open" })
}

// ---------------------------------------------------------------------------
// Model Query
// ---------------------------------------------------------------------------

export function queryModel(tabId: string): ModelKey | undefined {
  for (const reg of state.panes.values()) {
    if (reg.tabId === tabId && reg.capabilities.includes("model:provide")) {
      return reg.handlers["model:provide"]?.()
    }
  }
  return undefined
}

export function querySessionId(tabId: string): string | undefined {
  for (const reg of state.panes.values()) {
    if (reg.tabId === tabId && reg.capabilities.includes("session:provide")) {
      return reg.handlers["session:provide"]?.()
    }
  }
  return undefined
}

/**
 * Find the first peer registration with a given capability in a tab.
 * Returns the registration (leafId, tabId, etc.) or undefined.
 */
export function queryPeerLeaf(
  tabId: string,
  capability: PaneCapability,
): PaneRegistration | undefined {
  for (const reg of state.panes.values()) {
    if (reg.tabId === tabId && reg.capabilities.includes(capability)) {
      return reg
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

export function _reset(): void {
  state.panes.clear()
  state.bindings.clear()
  bump()
}
