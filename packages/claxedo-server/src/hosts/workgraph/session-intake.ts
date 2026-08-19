import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { createSessionIntakeService, type SessionIntakePort } from "@claxedo/workgraph"
import { isMasterSessionId } from "@claxedo/workgraph/contracts"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import { OPENCODE_INTERNAL_BASE } from "@claxedo/server-core/opencode/engine"

type SessionEvent = Readonly<{
  directory?: string
  payload: Readonly<{ type: string; properties?: Record<string, unknown> }>
}>

type EventSource = Readonly<{
  subscribe(listener: (event: SessionEvent) => unknown): () => void
}>

export class SessionIntakeDirectoryRequiredError extends Error {
  readonly code = "session_intake_directory_required"
  readonly retryable = false

  constructor() {
    super("WorkGraph Session intake requires an explicit Session directory")
    this.name = "SessionIntakeDirectoryRequiredError"
  }
}

/** Reads one idle Session's projection from whichever surface hosts it. */
export type IdleSessionReader = (
  sessionId: string,
  directory: string,
) => Promise<Awaited<ReturnType<typeof readIdleSession>>>

export function subscribeSessionIntake(input: Readonly<{
  events: EventSource
  readSession: IdleSessionReader
  port: SessionIntakePort
  /** Retained for source compatibility; each event's exact directory is authoritative. */
  directory?: string
  resolveContext(event: SessionEvent): WorkGraphContext | undefined
  onError?: (error: unknown) => void
}>) {
  const intake = createSessionIntakeService(input.port)
  return input.events.subscribe((event) => {
    if (!isIdle(event)) return
    const sessionId = String(event.payload.properties?.sessionID ?? "")
    if (!sessionId || sessionId.startsWith("ses_workgraph_") || isMasterSessionId(sessionId)) return
    const context = input.resolveContext(event)
    if (!context) return
    const directory = event.directory?.trim()
    if (!directory) {
      input.onError?.(new SessionIntakeDirectoryRequiredError())
      return
    }
    void input.readSession(sessionId, directory).then((session) =>
      intake.onIdle(context, session),
    ).catch((error) => input.onError?.(error))
  })
}

/** The engine-paired reader: projects an idle OpenCode ENGINE Session over the
 * injected engine transport. Pair it with the engine's own event bus. */
export function engineIdleSessionReader(request: OpenCodeRequestFn): IdleSessionReader {
  return (sessionId, directory) => readIdleSession(request, sessionId, directory)
}

/**
 * The harness-paired reader: projects an idle Session hosted by an embedded
 * workspace runtime — whatever its harness — through the same two compat reads
 * the engine reader issues, addressed to the runtime app for the Session's
 * directory. Pair it with the embedded-runtime compat event tap.
 */
export function runtimeIdleSessionReader(
  sessionRequest: (directory: string, request: Request) => Promise<Response>,
): IdleSessionReader {
  return async (sessionId, directory) => {
    const exactDirectory = directory.trim()
    if (!exactDirectory) throw new SessionIntakeDirectoryRequiredError()
    const read = (pathname: string) => {
      const url = new URL(pathname, "http://workgraph-session-intake.local")
      url.searchParams.set("directory", exactDirectory)
      return sessionRequest(exactDirectory, new Request(url))
    }
    const [sessionResponse, messagesResponse] = await Promise.all([
      read(`/session/${encodeURIComponent(sessionId)}`),
      read(`/session/${encodeURIComponent(sessionId)}/message?limit=100`),
    ])
    return projectIdleSession(sessionId, exactDirectory, sessionResponse, messagesResponse)
  }
}

export async function readIdleSession(
  request: OpenCodeRequestFn,
  sessionId: string,
  directory: string,
) {
  const exactDirectory = directory.trim()
  if (!exactDirectory) throw new SessionIntakeDirectoryRequiredError()
  const headers = { "x-opencode-directory": exactDirectory }
  const [sessionResponse, messagesResponse] = await Promise.all([
    request(new Request(`${OPENCODE_INTERNAL_BASE}/session/${encodeURIComponent(sessionId)}`, { headers })),
    request(new Request(`${OPENCODE_INTERNAL_BASE}/session/${encodeURIComponent(sessionId)}/message?limit=100`, { headers })),
  ])
  return projectIdleSession(sessionId, exactDirectory, sessionResponse, messagesResponse)
}

async function projectIdleSession(
  sessionId: string,
  exactDirectory: string,
  sessionResponse: Response,
  messagesResponse: Response,
) {
  if (!sessionResponse.ok || !messagesResponse.ok) throw new Error(`Unable to project idle Session ${sessionId}`)
  const session = await sessionResponse.json() as Record<string, unknown>
  const messages = await messagesResponse.json() as unknown
  const rows = Array.isArray(messages) ? messages : []
  const userText = rows.flatMap((message) => messageText(message, "user"))
  const assistantText = rows.flatMap((message) => messageText(message, "assistant"))
  const summary = assistantText.at(-1)?.trim() ?? ""
  const title = typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : userText[0]?.trim().slice(0, 120) || "AI work session"
  return {
    sessionId,
    title,
    summary: summary.slice(0, 8_000),
    meaningful: userText.some((text) => text.trim()) && !!summary,
    becameIdleAt: Date.now(),
    execution: {
      environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: exactDirectory },
      repository: { baseRevision: "HEAD" },
    },
  }
}

function isIdle(event: SessionEvent) {
  return event.payload.type === "session.status" &&
    (event.payload.properties?.status as { type?: string } | undefined)?.type === "idle"
}

function messageText(message: unknown, role: string) {
  if (!message || typeof message !== "object") return []
  const row = message as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }
  if (row.info?.role !== role) return []
  return (row.parts ?? []).filter((part) => part.type === "text" && !part.ignored && typeof part.text === "string")
    .map((part) => part.text!)
}
