import { createContext, useContext, type ParentProps } from "solid-js"
import type {
  AgentContentPart,
  AgentFilePart,
  AgentPresentationMessage,
  AgentPresentationProvider,
  AgentPresentationSession,
  AgentRuntimeStatus,
  AgentSnapshotFileDiff,
} from "@claxedo/agent-runtime-contract"
import type { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, AgentPresentationProvider>
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type DataSession =
  & Omit<AgentPresentationSession, "slug" | "version">
  & Partial<Pick<AgentPresentationSession, "slug" | "version">>

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: DataSession[]
  session_status: {
    [sessionId: string]: AgentRuntimeStatus
  }
  session_diff: {
    [sessionId: string]: AgentSnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionId: string]: PreloadMultiFileDiffResult<any, undefined>[]
  }
  message: {
    [sessionId: string]: AgentPresentationMessage[]
  }
  part: {
    [messageId: string]: AgentContentPart[]
  }
  part_text_accum_delta?: {
    [partId: string]: string
  }
}

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
}

export type DataProviderProps = {
  data: Data
  directory: string
  onNavigateToSession?: NavigateToSessionFn
  onSessionHref?: SessionHrefFn
  onTaskHref?: TaskHrefFn
  onClaxedoToolHref?: (tool: string, input: Record<string, unknown>, output?: string) => string | undefined
  resolveSubagents?: (
    parentSessionId: string,
    toolCallId?: string,
    hostableCallIds?: ReadonlySet<string>,
  ) => SubagentView[]
  fileUrl?: (path: string) => string | undefined
  readToolImage?: (attachment: AgentFilePart, signal: AbortSignal) => Promise<Blob>
}

function transcriptData(props: DataProviderProps) {
  return {
    get store() {
      return props.data
    },
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
