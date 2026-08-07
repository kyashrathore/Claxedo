import type {
  SubagentMode,
  SubagentStatus,
  SubagentToolCallRole,
  SubagentTranscript,
  SubagentUpdatedEvent,
} from "@claxedo/agent-event-runtime"

type MutableField = "mode" | "status" | "label" | "subagentType" | "description" | "transcript"
type ImmutableField = "providerId" | "providerKind" | "childSessionId"
type RevisionField = MutableField | ImmutableField

export type SubagentRegistryDiagnostic = {
  code: "subagent.binding_conflict" | "subagent.edge_conflict" | "subagent.invalid_edge" | "subagent.terminal_regression"
  parentSessionId: string
  subagentKey: string
  message: string
  revision: number
}

export type SubagentRegistryEntry = {
  parentSessionId: string
  subagentKey: string
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
  toolCallEdges: ReadonlyMap<string, SubagentToolCallRole>
  fieldRevisions: Readonly<Partial<Record<RevisionField, number>>>
}

export type SubagentRegistryChange =
  | { type: "upsert"; parentSessionId: string }
  | { type: "remove"; parentSessionId: string }
  | { type: "reset" }

export type SubagentRegistry = {
  apply(parentSessionId: string, event: SubagentUpdatedEvent): SubagentRegistryEntry
  get(parentSessionId: string, subagentKey: string): SubagentRegistryEntry | undefined
  list(parentSessionId?: string): SubagentRegistryEntry[]
  diagnostics(): SubagentRegistryDiagnostic[]
  deleteParent(parentSessionId: string): SubagentRegistryEntry[]
  archiveParent(parentSessionId: string): SubagentRegistryEntry[]
  workspaceChanged(): void
  replayGap(): void
  abortParent(parentSessionId: string, revisionFor: (entry: SubagentRegistryEntry) => number): SubagentRegistryEntry[]
  subscribe(listener: (change: SubagentRegistryChange) => void): () => void
}

type MutableEntry = Omit<SubagentRegistryEntry, "toolCallEdges" | "fieldRevisions"> & {
  toolCallEdges: Map<string, SubagentToolCallRole>
  fieldRevisions: Partial<Record<RevisionField, number>>
}

export function createSubagentRegistry(): SubagentRegistry {
  const entries = new Map<string, MutableEntry>()
  const diagnosticRows: SubagentRegistryDiagnostic[] = []
  const listeners = new Set<(change: SubagentRegistryChange) => void>()
  const notify = (change: SubagentRegistryChange) => {
    for (const listener of listeners) listener(change)
  }

  const apply = (parentSessionId: string, event: SubagentUpdatedEvent) => {
    const key = registryKey(parentSessionId, event.subagentKey)
    const entry = entries.get(key) ?? {
      parentSessionId,
      subagentKey: event.subagentKey,
      toolCallEdges: new Map(),
      fieldRevisions: {},
    }
    entries.set(key, entry)

    applyMutable(entry, event, "mode")
    applyStatus(entry, event, diagnosticRows)
    applyMutable(entry, event, "label")
    applyMutable(entry, event, "subagentType")
    applyMutable(entry, event, "description")
    applyMutable(entry, event, "transcript")
    applyImmutable(entry, event, "providerId", diagnosticRows)
    applyImmutable(entry, event, "providerKind", diagnosticRows)
    applyImmutable(entry, event, "childSessionId", diagnosticRows)
    applyEdge(entry, event, diagnosticRows)
    notify({ type: "upsert", parentSessionId })
    return clone(entry)
  }

  const removeParent = (parentSessionId: string) => {
    const removed = [...entries.values()].filter((entry) => entry.parentSessionId === parentSessionId)
    for (const entry of removed) entries.delete(registryKey(parentSessionId, entry.subagentKey))
    notify({ type: "remove", parentSessionId })
    return removed.map(clone)
  }

  return {
    apply,
    get(parentSessionId, subagentKey) {
      const entry = entries.get(registryKey(parentSessionId, subagentKey))
      return entry ? clone(entry) : undefined
    },
    list(parentSessionId) {
      return [...entries.values()]
        .filter((entry) => parentSessionId === undefined || entry.parentSessionId === parentSessionId)
        .map(clone)
    },
    diagnostics: () => diagnosticRows.map((row) => ({ ...row })),
    deleteParent: removeParent,
    archiveParent: removeParent,
    workspaceChanged() {
      entries.clear()
      notify({ type: "reset" })
    },
    replayGap() {
      entries.clear()
      notify({ type: "reset" })
    },
    abortParent(parentSessionId, revisionFor) {
      const interrupted = [...entries.values()].filter((entry) =>
        entry.parentSessionId === parentSessionId &&
        entry.mode !== "background" &&
        (!entry.status || !terminal(entry.status))
      )
      return interrupted.map((entry) => apply(parentSessionId, {
        type: "subagent-updated",
        subagentKey: entry.subagentKey,
        revision: revisionFor(clone(entry)),
        status: "interrupted",
      }))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function applyMutable<Field extends MutableField>(
  entry: MutableEntry,
  event: SubagentUpdatedEvent,
  field: Field,
) {
  const value = event[field]
  if (value === undefined || event.revision <= (entry.fieldRevisions[field] ?? 0)) return
  entry[field] = value as MutableEntry[Field]
  entry.fieldRevisions[field] = event.revision
}

function applyStatus(
  entry: MutableEntry,
  event: SubagentUpdatedEvent,
  diagnostics: SubagentRegistryDiagnostic[],
) {
  if (event.status === undefined) return
  const currentRevision = entry.fieldRevisions.status ?? 0
  if (entry.status && terminal(entry.status) && !terminal(event.status)) {
    diagnostics.push({
      code: "subagent.terminal_regression",
      parentSessionId: entry.parentSessionId,
      subagentKey: entry.subagentKey,
      message: `ignored status transition from terminal ${entry.status} to ${event.status}`,
      revision: event.revision,
    })
    entry.fieldRevisions.status = Math.max(currentRevision, event.revision)
    return
  }
  if (terminal(event.status) && (!entry.status || !terminal(entry.status))) {
    entry.status = event.status
    entry.fieldRevisions.status = Math.max(currentRevision, event.revision)
    return
  }
  if (event.revision <= currentRevision) return
  entry.status = event.status
  entry.fieldRevisions.status = event.revision
}

function applyImmutable<Field extends ImmutableField>(
  entry: MutableEntry,
  event: SubagentUpdatedEvent,
  field: Field,
  diagnostics: SubagentRegistryDiagnostic[],
) {
  const value = event[field]
  if (value === undefined) return
  const current = entry[field]
  if (current !== undefined && current !== value) {
    diagnostics.push({
      code: "subagent.binding_conflict",
      parentSessionId: entry.parentSessionId,
      subagentKey: entry.subagentKey,
      message: `ignored conflicting immutable ${field} binding`,
      revision: event.revision,
    })
    return
  }
  if (event.revision <= (entry.fieldRevisions[field] ?? 0)) return
  entry[field] = value
  entry.fieldRevisions[field] = event.revision
}

function applyEdge(
  entry: MutableEntry,
  event: SubagentUpdatedEvent,
  diagnostics: SubagentRegistryDiagnostic[],
) {
  if (!event.toolCallId && !event.toolCallRole) return
  if (!event.toolCallId || !event.toolCallRole) {
    diagnostics.push({
      code: "subagent.invalid_edge",
      parentSessionId: entry.parentSessionId,
      subagentKey: entry.subagentKey,
      message: "tool-call edges require both toolCallId and toolCallRole",
      revision: event.revision,
    })
    return
  }
  const current = entry.toolCallEdges.get(event.toolCallId)
  if (!current) {
    entry.toolCallEdges.set(event.toolCallId, event.toolCallRole)
    return
  }
  if (current === event.toolCallRole) return
  diagnostics.push({
    code: "subagent.edge_conflict",
    parentSessionId: entry.parentSessionId,
    subagentKey: entry.subagentKey,
    message: `ignored conflicting role for tool call ${event.toolCallId}`,
    revision: event.revision,
  })
}

function clone(entry: MutableEntry): SubagentRegistryEntry {
  return {
    ...entry,
    ...(entry.transcript ? { transcript: { ...entry.transcript } } : {}),
    toolCallEdges: new Map(entry.toolCallEdges),
    fieldRevisions: { ...entry.fieldRevisions },
  }
}

function registryKey(parentSessionId: string, subagentKey: string) {
  return `${parentSessionId}\0${subagentKey}`
}

function terminal(status: SubagentStatus) {
  return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
}
