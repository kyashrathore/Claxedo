import { isDeepStrictEqual } from "node:util"
import type { EventMessagePartUpdated, EventMessageUpdated } from "@claxedo/agent-event-runtime/client-presentation"
import {
  importOpenCodeFixtureSessions,
  openCodePartId,
  type OpenCodeFixtureSession,
  type OpenCodeFixtureReadback,
} from "@claxedo/workspace-runtime/testing"

type Data = Record<string, unknown>
type Session = { id: string; projectId: string; directory: string; title: string; created: number; updated: number }
type Message = { id: string; sessionId: string; data: Data }
type Part = { id: string; messageId: string; ordinal: number; data: Data; updatedAt?: number }
type TranscriptEvent = EventMessageUpdated | EventMessagePartUpdated

/** Holds the pinned transcript records and converts their native SDK copy. */
export class OpenCodeCorpus {
  sessions = new Map<string, Session>()
  messages = new Map<string, Message>()
  parts = new Map<string, Part>()
  private readonly sessionMessages = new Map<string, Message[]>()
  private readonly messageParts = new Map<string, Map<string, Part>>()
  private readonly recordedEvents = new Map<string, TranscriptEvent[]>()
  private readonly recordedIds = new Set<string>()

  constructor(private readonly source: "snapshot" | "recorded-events" = "snapshot") {}

  addSession(value: Session) {
    if (this.sessions.has(value.id)) throw new Error(`Duplicate corpus session: ${value.id}`)
    this.sessions.set(value.id, value)
  }

  addMessage(id: string, sessionId: string, data: Data) {
    if (!this.sessions.has(sessionId) || this.messages.has(id)) throw new Error(`Invalid corpus message: ${id}`)
    const message = { id, sessionId, data }
    this.messages.set(id, message)
    const rows = this.sessionMessages.get(sessionId) ?? []
    rows.push(message)
    this.sessionMessages.set(sessionId, rows)
  }

  setPart(id: string, messageId: string, ordinal: number, data: Data, updatedAt?: number) {
    if (!this.messages.has(messageId)) throw new Error(`Unknown corpus message: ${messageId}`)
    const previous = this.parts.get(id)
    if (previous && previous.messageId !== messageId) throw new Error(`Corpus part changed its message: ${id}`)
    const part = { id, messageId, ordinal: previous?.ordinal ?? ordinal, data, updatedAt }
    this.parts.set(id, part)
    const rows = this.messageParts.get(messageId) ?? new Map<string, Part>()
    rows.set(id, part)
    this.messageParts.set(messageId, rows)
  }

  recordEvent(event: { id: string; type: TranscriptEvent["type"]; properties: Data }) {
    if (this.source !== "recorded-events") throw new Error("Snapshot corpus cannot claim recorded event provenance")
    const sessionId = text(event.properties.sessionID)
    const key = `${sessionId}:${event.id}`
    if (!text(event.id) || !this.sessions.has(sessionId) || this.recordedIds.has(key)) {
      throw new Error("Invalid corpus event identity")
    }
    const value = record(event.type === "message.updated" ? event.properties.info : event.properties.part)
    const message = this.messages.get(text(event.type === "message.updated" ? value.id : value.messageID))
    if (value.sessionID !== sessionId || message?.sessionId !== sessionId) {
      throw new Error("Corpus event disagrees with its transcript owner")
    }
    if (event.type === "message.part.updated") number(event.properties.time)
    this.recordedIds.add(key)
    const events = this.recordedEvents.get(sessionId) ?? []
    events.push(structuredClone(event) as TranscriptEvent)
    this.recordedEvents.set(sessionId, events)
  }

  async persist(databasePath: string): Promise<OpenCodeFixtureReadback[]> {
    const transfers = [...this.sessions.values()].map((session) => ({
      info: {
        id: session.id,
        projectID: session.projectId,
        title: session.title,
        location: { directory: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: session.created, updated: session.updated },
      },
      messages: (this.sessionMessages.get(session.id) ?? []).map((message) => this.message(message)),
    })) satisfies OpenCodeFixtureSession[]
    const restored = await importOpenCodeFixtureSessions(databasePath, transfers)
    for (const [index, actual] of restored.entries()) {
      const expected = transfers[index]!
      if (
        actual.info.id !== expected.info.id ||
        actual.info.title !== expected.info.title ||
        actual.info.location.directory !== expected.info.location.directory ||
        actual.info.time.created !== expected.info.time.created ||
        actual.info.time.updated !== expected.info.time.updated ||
        !isDeepStrictEqual(actual.messages, expected.messages)
      ) {
        throw new Error(`SDK corpus readback differs for ${expected.info.id}`)
      }
    }
    return restored
  }

  /** Replay only the validated corpus records into Claxedo's transcript owner. */
  *events(sessionId: string): Generator<TranscriptEvent> {
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown corpus session: ${sessionId}`)
    if (this.source === "recorded-events") {
      const events = this.recordedEvents.get(sessionId) ?? []
      const expected = (this.sessionMessages.get(sessionId) ?? []).reduce(
        (count, message) => count + 1 + (this.messageParts.get(message.id)?.size ?? 0),
        0,
      )
      if (events.length !== expected) throw new Error(`Incomplete recorded corpus events: ${sessionId}`)
      yield* events
      return
    }
    // Snapshot inputs have no transport envelopes. Import their records through
    // the journal API using stable record keys and the source part timestamp.
    for (const message of this.sessionMessages.get(sessionId) ?? []) {
      yield {
        id: `message.updated:${message.id}`,
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: { ...message.data, id: message.id, sessionID: sessionId } as EventMessageUpdated["properties"]["info"],
        },
      }
      const parts = [...(this.messageParts.get(message.id)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal)
      for (const part of parts) {
        yield {
          id: `message.part.updated:${part.id}`,
          type: "message.part.updated",
          properties: {
            sessionID: sessionId,
            time: number(part.updatedAt),
            part: {
              ...part.data,
              id: part.id,
              messageID: message.id,
              sessionID: sessionId,
            } as EventMessagePartUpdated["properties"]["part"],
          },
        }
      }
    }
  }

  private message(message: Message): OpenCodeFixtureSession["messages"][number] {
    const parts = [...(this.messageParts.get(message.id)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal)
    const data = message.data
    const time = record(data.time)
    const created = number(time.created)
    if (data.role === "user") {
      if (parts.some((part) => part.data.type !== "text")) {
        throw new Error("The runtime transcript projection cannot represent non-text user corpus parts")
      }
      return {
        id: message.id,
        type: "user",
        time: { created },
        text: parts.map((part) => text(part.data.text)).join("\n"),
      }
    }
    if (data.role !== "assistant" || time.completed === undefined)
      throw new Error("Corpus imports require settled assistant messages")
    const completed = number(time.completed)
    type Assistant = Extract<OpenCodeFixtureSession["messages"][number], { type: "assistant" }>
    type Tool = Extract<Assistant["content"][number], { type: "tool" }>
    const content: Assistant["content"][number][] = []
    // Match the published SDK's V1 migration: steps and patches belong to the
    // assistant snapshot/usage fields, not to renderable transcript content.
    const start =
      parts.find((part) => part.data.type === "step-start" && part.data.snapshot)?.data.snapshot ??
      parts.find((part) => part.data.type === "snapshot")?.data.snapshot ??
      parts.find((part) => part.data.type === "patch")?.data.hash
    const end = parts.findLast((part) => part.data.type === "step-finish" && part.data.snapshot)?.data.snapshot
    const files = parts
      .filter((part) => part.data.type === "patch")
      .flatMap((part) => {
        if (!Array.isArray(part.data.files)) throw new Error("Expected corpus patch files")
        return part.data.files.map(text)
      })
    const snapshot = {
      ...(start !== undefined ? { start: text(start) } : {}),
      ...(end !== undefined ? { end: text(end) } : {}),
      ...(files.length ? { files: [...new Set(files)] } : {}),
    } satisfies NonNullable<Assistant["snapshot"]>
    for (const part of parts) {
      const value = part.data
      if (["step-start", "step-finish", "snapshot", "patch"].includes(String(value.type))) {
        continue
      }
      const id = openCodePartId(
        message.id,
        "assistant",
        value.type === "tool" ? { id: text(value.callID) } : {},
        content.length,
      )
      if (value.type === "text" || value.type === "reasoning") {
        content.push({ type: value.type, text: text(value.text) })
      } else if (value.type === "tool") {
        const source = record(value.state)
        // The SDK validates the JSON input at import; this assertion is confined
        // to the corpus wire-format conversion rather than spread across writers.
        const input = record(source.input) as Extract<Tool["state"], { status: "completed" }>["input"]
        let state: Tool["state"]
        if (source.status === "completed") {
          state = { status: "completed", input, content: [{ type: "text", text: text(source.output) }] }
        } else if (source.status === "error") {
          state = { status: "error", input, error: { type: "tool_error", message: text(source.error) } }
        } else if (source.status === "running") {
          state = {
            status: "running",
            input,
            metadata:
              source.metadata === undefined
                ? {}
                : (record(source.metadata) as Extract<Tool["state"], { status: "running" }>["metadata"]),
          }
        } else if (source.status === "pending") {
          state = { status: "streaming", input: text(source.raw) }
        } else throw new Error(`Unsupported corpus tool state: ${source.status}`)
        content.push({ type: "tool", id, name: text(value.tool), time: { created, completed }, state })
      } else {
        throw new Error(`Unsupported assistant corpus part: ${value.type}`)
      }
    }
    return {
      id: message.id,
      type: "assistant",
      agent: text(data.agent),
      model: { providerID: text(data.providerID), id: text(data.modelID) },
      time: { created, completed },
      content,
      ...(Object.keys(snapshot).length ? { snapshot } : {}),
      ...(data.cost !== undefined ? { cost: number(data.cost) } : {}),
      ...(data.tokens !== undefined ? { tokens: tokens(data.tokens) } : {}),
      ...(data.finish ? { finish: text(data.finish) as Assistant["finish"] } : {}),
    }
  }
}

function tokens(value: unknown) {
  const usage = record(value)
  const cache = record(usage.cache)
  return {
    input: number(usage.input),
    output: number(usage.output),
    reasoning: number(usage.reasoning),
    cache: { read: number(cache.read), write: number(cache.write) },
  }
}

function record(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a corpus object")
  return value as Data
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected corpus text")
  return value
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite corpus timestamp")
  return value
}
