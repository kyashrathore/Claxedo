import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { AgentRuntimeDirectory, QueuedMessageRecord } from "@/platform/runtime/agent/agent-runtime-client"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { getClaxedoServerUrl } from "@/platform/api/api"
import type { SessionRef } from "@/platform/identity/session-ref"
import { usePrompt } from "@/features/session/providers/prompt"
import { useLanguage } from "@/platform/i18n/provider"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

export const QUEUED_MESSAGES_QUERY_KEY = "session-queued-messages"

export type QueuedMessagesController = {
  items: Accessor<QueuedMessageRecord[]>
  loadFailed: Accessor<boolean>
  /** The seq a control request is in flight for; every control is disabled meanwhile. */
  pending: Accessor<number | undefined>
  error: Accessor<string | undefined>
  /** The seq whose text the composer is holding for a replace. */
  editing: Accessor<number | undefined>
  reload: () => void
  sendNow: (seq: number) => void
  remove: (seq: number) => void
  /** Holds the record on the runtime and loads its text into the composer. */
  beginEdit: (record: QueuedMessageRecord) => void
  /** Releases the record; the composer's own edit also drops its draft. */
  cancelEdit: (seq: number) => void
}

/**
 * The runtime's durable queue for one session. Records are not transcript
 * messages until the runtime admits them, so nothing here touches the message
 * store; the timeline renders them from this query alone. An edit lives on the
 * session's prompt draft, where the composer's send finds it.
 */
export function createQueuedMessagesController(props: {
  active: Accessor<boolean>
  working: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  directory: Accessor<AgentRuntimeDirectory>
  sessionRef: Accessor<SessionRef | undefined>
  signedControlPlane: Accessor<boolean | undefined>
  workspaceId: Accessor<string | undefined>
  hostKind: Accessor<RelayHostKind | undefined>
  focusComposer: () => void
}): QueuedMessagesController {
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const language = useLanguage()
  const client = createMemo(() => createAgentRuntimeClient({
    serverUrl: getClaxedoServerUrl(),
    sessionRef: props.sessionRef(), signedControlPlane: props.signedControlPlane(),
    workspaceId: props.workspaceId(), hostKind: props.hostKind(),
  }))
  const queue = useQuery(() => ({
    queryKey: [QUEUED_MESSAGES_QUERY_KEY, getClaxedoServerUrl(), props.sessionRef(), props.workspaceId(), props.signedControlPlane(), props.directory(), props.sessionID()],
    enabled: props.active() && !!props.sessionID(),
    queryFn: () => client().queuedMessages({ directory: props.directory(), sessionID: props.sessionID()! }),
    refetchInterval: (query) => props.active() && (props.working() || query.state.data?.length) ? 1000 : false,
    retry: false,
  }))
  const items = createMemo(() => queue.data ?? [])
  const editing = createMemo(() => {
    const edit = prompt.queuedEdit.current()
    return edit && items().some((item) => item.seq === edit.seq) ? edit.seq : undefined
  })
  // The runtime admitted or dropped the record the composer was editing; the
  // draft stays in the composer and sends as a new message.
  createEffect(() => {
    const edit = prompt.queuedEdit.current()
    if (edit && queue.data && !queue.data.some((item) => item.seq === edit.seq)) prompt.queuedEdit.set(undefined)
  })
  const [pending, setPending] = createSignal<number>()
  const [error, setError] = createSignal<string>()
  const control = async (seq: number, action: "cancel" | "steer" | "hold" | "release") => {
    const sessionID = props.sessionID()
    if (!sessionID) return false
    setPending(seq)
    setError(undefined)
    try {
      await client().controlQueuedMessage({ directory: props.directory(), sessionID, seq, action })
      if (action !== "hold" && prompt.queuedEdit.current()?.seq === seq) prompt.queuedEdit.set(undefined)
      await queue.refetch()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : language.t("ui.message.queued.updateFailed"))
      return false
    } finally {
      setPending(undefined)
    }
  }
  const cancelEdit = (seq: number) => {
    if (prompt.queuedEdit.current()?.seq === seq) prompt.reset()
    void control(seq, "release")
  }
  return {
    items,
    loadFailed: () => queue.isError,
    pending,
    error,
    editing,
    reload: () => void queryClient.invalidateQueries({ queryKey: [QUEUED_MESSAGES_QUERY_KEY] }),
    sendNow: (seq) => void control(seq, "steer"),
    remove: (seq) => void control(seq, "cancel"),
    beginEdit: (record) => {
      void control(record.seq, "hold").then((held) => {
        if (!held) return
        prompt.queuedEdit.set({
          seq: record.seq,
          ...(record.messageId ? { messageId: record.messageId } : {}),
          cancel: () => cancelEdit(record.seq),
        })
        const text = queuedMessageText(record)
        prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        props.focusComposer()
      })
    },
    cancelEdit,
  }
}

export function queuedMessageText(record: QueuedMessageRecord): string {
  return record.parts.filter((part) => part.type === "text" && !!part.text).map((part) => part.text).join("\n")
}
