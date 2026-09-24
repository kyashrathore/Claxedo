export class ApiError extends Error {
  constructor(readonly method: string, readonly route: string, readonly status: number, readonly body: string) {
    super(`${method} ${route} answered ${status}: ${body}`)
    this.name = "ApiError"
  }
}

export type SessionHarness = { id: string; access: "native" | "connection" }
export type HarnessSelection = { kind: "native"; harnessId: string } | { kind: "connection"; connectionId: string }

export type SessionRow = {
  id: string
  title: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  [key: string]: unknown
}

export type MessagePart = { id?: string; type: string; text?: string; [key: string]: unknown }
export type MessageRow = { info: { id: string; role: string; [key: string]: unknown }; parts: MessagePart[] }
export type PermissionRow = { id: string; sessionID: string; [key: string]: unknown }
export type QuestionRow = { id: string; sessionID: string; [key: string]: unknown }

type CallOptions = { directory?: string; body?: unknown; query?: Record<string, string> }

export function assistantText(messages: MessageRow[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

export class ClaxedoApi {
  constructor(readonly url: string) {}

  private async call<T>(method: string, route: string, options: CallOptions = {}): Promise<T> {
    const target = new URL(route, this.url)
    if (options.directory) target.searchParams.set("directory", options.directory)
    for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, value)
    const response = await fetch(target, {
      method,
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    if (!response.ok) throw new ApiError(method, target.pathname, response.status, text)
    return (text ? JSON.parse(text) : undefined) as T
  }

  health() {
    return this.call<Record<string, unknown>>("GET", "/api/claxedo/health")
  }

  resolveWorkspace(directory: string) {
    return this.call<{ workspaceId: string }>("POST", "/api/workspace/resolve", { directory })
  }

  setHarness(directory: string, selection: HarnessSelection) {
    return this.call<unknown>("POST", "/api/claxedo/agent-config/harness", { directory, body: { harness: selection } })
  }

  createSession(directory: string, input: { harness: SessionHarness; title?: string; parentId?: string; permissionMode?: string }) {
    const query: Record<string, string> = input.harness.access === "native"
      ? { nativeHarness: input.harness.id }
      : { connectionId: input.harness.id }
    return this.call<SessionRow>("POST", "/session", {
      directory,
      query,
      body: {
        ...(input.title ? { title: input.title } : {}),
        harness: input.harness,
        ...(input.parentId ? { parentID: input.parentId } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      },
    })
  }

  session(directory: string, id: string) {
    return this.call<SessionRow>("GET", `/session/${encodeURIComponent(id)}`, { directory })
  }

  sessions(directory: string) {
    return this.call<SessionRow[]>("GET", "/session", { directory })
  }

  deleteSession(directory: string, id: string) {
    return this.call<unknown>("DELETE", `/session/${encodeURIComponent(id)}`, { directory })
  }

  prompt(directory: string, id: string, text: string, options: { messageId?: string } = {}) {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/message`, {
      directory,
      body: { parts: [{ type: "text", text }], ...(options.messageId ? { messageID: options.messageId } : {}) },
    })
  }

  promptAsync(directory: string, id: string, text: string, options: { messageId?: string } = {}) {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
      directory,
      body: { parts: [{ type: "text", text }], ...(options.messageId ? { messageID: options.messageId } : {}) },
    })
  }

  abort(directory: string, id: string) {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/abort`, { directory })
  }

  async messages(directory: string, id: string): Promise<MessageRow[]> {
    const body = await this.call<MessageRow[] | { messages: MessageRow[] }>("GET", `/session/${encodeURIComponent(id)}/message`, { directory })
    return Array.isArray(body) ? body : body.messages
  }

  status(directory: string) {
    return this.call<Record<string, { type: string; [key: string]: unknown }>>("GET", "/session/status", { directory })
  }

  permissions(directory: string) {
    return this.call<PermissionRow[]>("GET", "/permission", { directory })
  }

  replyPermission(directory: string, sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      directory,
      body: { response },
    })
  }

  questions(directory: string) {
    return this.call<QuestionRow[]>("GET", "/question", { directory })
  }

  replyQuestion(directory: string, questionId: string, answers: string[][]) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reply`, { directory, body: { answers } })
  }

  rejectQuestion(directory: string, questionId: string) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reject`, { directory })
  }
}
