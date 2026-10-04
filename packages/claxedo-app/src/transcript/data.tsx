import { createContext, useContext, type ParentProps } from "solid-js"
import type { AgentFilePart, AgentToolPart } from "@claxedo/agent-runtime-contract"

export type NavigateToSessionFn = (sessionId: string) => void

export type SessionHrefFn = (sessionId: string) => string

export type TaskHrefFn = (taskId: string) => string

export type SubagentView = {
  parentSessionId: string
  subagentKey: string
  toolCallRole?: "spawn" | "interaction"
  mode?: "foreground" | "background"
  status: "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "killed" | "unknown"
  label: string
  agentLabel: string
  description: string
  childSessionId?: string
  transcriptKind: "live" | "file" | "messages" | "none" | "unknown"
  resolution: "not-yet-bound" | "loading" | "ready" | "empty" | "unavailable"
  ambient: boolean
  stopCall?: string
}

export type SubagentStopAnswer = { ok: true } | { ok: false; message: string }

export type DataProviderProps = {
  directory: string
  onNavigateToSession?: NavigateToSessionFn
  onSessionHref?: SessionHrefFn
  onTaskHref?: TaskHrefFn
  onClaxedoToolHref?: (tool: string, input: Record<string, unknown>, output?: string) => string | undefined
  resolveSubagents?: (parentSessionId: string, toolCallId?: string) => SubagentView[]
  fileUrl?: (path: string) => string | undefined
  readToolImage?: (attachment: AgentFilePart, signal: AbortSignal) => Promise<Blob>
  loadToolBody?: (part: AgentToolPart) => void
  stopBackgroundTask?: (parentSessionId: string, toolCallId: string) => Promise<SubagentStopAnswer>
}

function transcriptData(props: DataProviderProps) {
  return {
    get directory() {
      return props.directory
    },
    navigateToSession: props.onNavigateToSession,
    sessionHref: props.onSessionHref,
    taskHref: props.onTaskHref,
    claxedoToolHref: props.onClaxedoToolHref,
    resolveSubagents: props.resolveSubagents,
    fileUrl: props.fileUrl,
    readToolImage: props.readToolImage,
    loadToolBody: props.loadToolBody,
    stopBackgroundTask: props.stopBackgroundTask,
  }
}

type RendererData = ReturnType<typeof transcriptData>

const DataContext = createContext<RendererData>()

export function DataProvider(props: ParentProps<DataProviderProps>) {
  return <DataContext.Provider value={transcriptData(props)}>{props.children}</DataContext.Provider>
}

export function useData(): RendererData {
  const data = useContext(DataContext)
  if (!data) throw new Error("useData needs a DataProvider above it")
  return data
}

export function useOptionalData(): RendererData | undefined {
  return useContext(DataContext)
}
