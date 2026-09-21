import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { skipToken, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { Persist, persisted } from "@/platform/persistence/persist"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { holdSessionEventScope } from "@/platform/runtime/session-event-scope"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

/** A draft stores an owner reference only. The runtime owns progress and resolvers. */
export function createDraftSessionStart(input: {
  serverUrl: string
  draftId: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
  signedControlPlane: Accessor<boolean>
  hostKind: Accessor<RelayHostKind | undefined>
  locationSearch?: Accessor<string>
  replaceSearch?: (search: string) => void
  prepareRecoveredSession?: (binding: AgentSessionStartBinding, draftId: string) => Promise<void>
  onRecoveredCreated?: (binding: AgentSessionStartBinding) => void
}) {
  const draftId = createMemo(() => new URLSearchParams(input.locationSearch?.() ?? "").get("draftId") || input.draftId())
  const publishDraftRoute = (id: string | undefined) => {
    const search = new URLSearchParams(input.locationSearch?.() ?? "")
    if (id) search.set("draftId", id)
    else search.delete("draftId")
    input.replaceSearch?.(search.size ? `?${search}` : "")
  }
  const [references, setReferences, hydration, ready] = persisted(
    Persist.serverGlobal(input.serverUrl, "draft-session-starts"),
    createStore<{ drafts: Record<string, AgentSessionStartBinding | undefined> }>({ drafts: {} }),
  )
  const reference = createMemo(() => {
    if (!ready() || (input.sessionId() && input.sessionId() !== "new")) return undefined
    const currentDraftId = draftId()
    return currentDraftId ? references.drafts[currentDraftId] : undefined
  })
  const client = (owner: AgentSessionStartBinding) => createAgentRuntimeClient({
    serverUrl: input.serverUrl, workspaceId: owner.workspaceId,
    signedControlPlane: input.signedControlPlane(), hostKind: input.hostKind(),
  })
  const liveCreations = new Set<string>()
  const cache = useQueryClient()
  let disposed = false
  onCleanup(() => { disposed = true })
  const [failure, setFailure] = createSignal<{ draftId: string; message: string }>()
  const status = useQuery(() => {
    const owner = reference()
    const currentDraftId = draftId()
    return {
      queryKey: queryKeys.runtime.sessionStart(input.serverUrl, owner?.workspaceId, owner?.sessionId, owner?.operationId),
      enabled: !!owner,
      queryFn: owner ? async ({ signal }) => {
        const result = (await client(owner).getSessionStart({ directory: owner.directory, sessionID: owner.sessionId, signal })).data
        if (Object.entries(owner).some(([key, value]) => result.binding[key as keyof AgentSessionStartBinding] !== value)) {
          throw new Error("Session start response does not match this draft's creation owner")
        }
        const current = () => !disposed && !signal.aborted && draftId() === currentDraftId
          && reference()?.operationId === owner.operationId
        if (!current()) return result
        if (result.status !== "starting" && currentDraftId) {
          if (result.status === "created" && liveCreations.has(currentDraftId)) return result
          if (result.status === "created") await input.prepareRecoveredSession?.(owner, currentDraftId)
          if (!current()) return result
          if (references.drafts[currentDraftId]?.operationId === owner.operationId) {
            const selected = draftId() === currentDraftId
            setReferences("drafts", currentDraftId, undefined)
            if (selected) publishDraftRoute(undefined)
            if (result.status === "failed") setFailure({ draftId: selected ? draftId() ?? currentDraftId : currentDraftId, message: result.error })
            if (result.status === "created" && selected) input.onRecoveredCreated?.(owner)
          }
        }
        return result
      } : skipToken,
    }
  })
  createEffect(() => {
    const owner = reference()
    if (!owner) return
    onCleanup(holdSessionEventScope(owner.sessionId, `workspace:${owner.workspaceId}`))
  })
  return {
    draftId,
    pending: () => !!reference(),
    binding: () => status.data?.status === "starting" && status.data.binding.operationId === reference()?.operationId ? reference() : undefined,
    error: () => (failure()?.draftId === draftId() ? failure()?.message : undefined) ?? (reference() && status.error instanceof Error ? status.error.message : undefined),
    update(updatedDraftId: string, binding: AgentSessionStartBinding | undefined, outcome?: "transport-failed") {
      // The callback carries the original draft, so a late event cannot attach
      // one draft's question to the currently displayed draft.
      if (binding) liveCreations.add(updatedDraftId)
      else liveCreations.delete(updatedDraftId)
      if (outcome === "transport-failed") {
        const owner = references.drafts[updatedDraftId]
        if (owner) void cache.invalidateQueries({
          queryKey: queryKeys.runtime.sessionStart(input.serverUrl, owner.workspaceId, owner.sessionId, owner.operationId),
          exact: true,
        })
        return
      }
      const write = () => setReferences("drafts", updatedDraftId, binding)
      if (ready()) write()
      else void Promise.resolve(hydration).then(write)
      if (updatedDraftId === draftId()) {
        if (binding || new URLSearchParams(input.locationSearch?.() ?? "").has("draftId")) publishDraftRoute(binding ? updatedDraftId : undefined)
        setFailure(undefined)
      }
    },
  }
}

/** Lifecycle and stream recovery trigger authoritative readback through the existing query cache. */
export function invalidateSessionStarts(input: { serverUrl: string; workspaceId?: string; sessionId?: string }) {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.runtime.sessionStarts(input.serverUrl),
    predicate: ({ queryKey }) => (!input.workspaceId || queryKey[3] === input.workspaceId)
      && (!input.sessionId || queryKey[4] === input.sessionId),
  })
}
