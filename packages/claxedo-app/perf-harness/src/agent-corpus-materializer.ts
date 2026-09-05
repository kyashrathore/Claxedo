import { createHash } from "node:crypto"
import { mkdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { OpenCodeCorpus } from "./opencode-corpus"
import { createOpenCodeFixtureIds } from "@claxedo/workspace-runtime/testing"
import type { AgentAppProfile } from "./agent-driver-contract"
import { initializeWorkspace, type MaterializedWorkspace } from "./workspace-fixture"
import { persistClaxedoCorpus, registerWorkspace } from "./fixture-registration"

export type CorpusPart = {
  id: string
  order: number
  type: string
  [key: string]: unknown
}
export type CorpusMessage = {
  id: string
  order: number
  role: "system" | "user" | "assistant"
  parts: CorpusPart[]
}
export type CorpusTurn = {
  id: string
  index: number
  anchor?: string
  messages: CorpusMessage[]
}
export type CorpusSession = {
  id: string
  title: string
  order: number
  workspaceId?: string
  turns: CorpusTurn[]
  events: Array<Record<string, unknown>>
  terminalStreams: Array<Record<string, unknown>>
}
export type AgentAppCorpus = {
  schemaVersion: 1
  kind: "agent-app-corpus"
  corpusId: string
  source: "generated-public" | "opencode-local"
  seed: string
  sessions: CorpusSession[]
  manifest: {
    counts: Record<string, number>
    hashes: {
      corpusSha256: string
      semanticSha256: string
      terminalSha256: string
    }
  }
}

export type MaterializedCorpusPart = {
  corpusPartId: string
  corpusMessageId: string
  partId: string
  messageId: string
  sessionId: string
  payload: Record<string, unknown>
}

export async function readCanonicalCorpusDigest(corpusPath: string) {
  const corpus = parseCorpus(JSON.parse(await readFile(corpusPath, "utf8")))
  const digest = corpusDigest(corpus)
  if (digest !== corpus.manifest.hashes.corpusSha256) {
    throw new Error("corpus manifest digest does not match the canonical v1 payload")
  }
  return digest
}

export async function materializeClaxedoCorpus(input: {
  corpusPath: string
  corpusDigestSha256: string
  dataDirectory: string
  workspaceDirectory: string
  profiles: AgentAppProfile[]
}) {
  const corpus = parseCorpus(JSON.parse(await readFile(input.corpusPath, "utf8")))
  const computedDigest = corpusDigest(corpus)
  if (computedDigest !== input.corpusDigestSha256 || computedDigest !== corpus.manifest.hashes.corpusSha256) {
    throw new Error("corpus digest does not match the canonical v1 payload")
  }
  await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
  const workspaceDirectory = await realpath(input.workspaceDirectory)
  // Multi-workspace corpora carry a per-session workspace assignment; give
  // each its own git-rooted directory and registration so warm switching
  // crosses REAL workspace boundaries. The root commit message embeds the
  // workspace id — the deterministic commit would otherwise produce the SAME
  // sha (= project id) for every workspace.
  const workspaceIds = [...new Set(corpus.sessions.map((session) => session.workspaceId ?? ""))].sort()
  const workspaces = new Map<string, MaterializedWorkspace>()
  for (const workspaceId of workspaceIds) {
    const directory = workspaceId ? path.join(workspaceDirectory, workspaceId) : workspaceDirectory
    if (workspaceId) await mkdir(directory, { recursive: true, mode: 0o700 })
    const projectId = await initializeWorkspace(directory, workspaceId)
    await registerWorkspace({
      dataDirectory: input.dataDirectory,
      directory,
      projectId,
      projectName: workspaceId ? `Benchmark ${corpus.corpusId} ${workspaceId}` : `Benchmark ${corpus.corpusId}`,
    })
    workspaces.set(workspaceId, { directory, projectId })
  }
  const { createId } = await createOpenCodeFixtureIds()

  const database = new OpenCodeCorpus()
  const materializedSessions = new Map<string, string>()
  const materializedParts = new Map<string, MaterializedCorpusPart>()
  const readinessTargets: Array<{
    sessionId: string
    title: string
    expectedMessageIds: string[]
    expectedContentSha256: Record<string, string>
    expectedTextPartSha256: Record<string, string>
    expectedPartIds: string[]
  }> = []
  const baseTime = Date.parse("2020-01-01T00:00:00.000Z")

  for (const session of corpus.sessions.toSorted((a, b) => a.order - b.order)) {
    const sessionTime = baseTime + session.order * 1_000_000
    const sessionId = createId("ses", sessionTime)
    materializedSessions.set(session.id, sessionId)
    const home = workspaces.get(session.workspaceId ?? "")
    if (!home) throw new Error(`corpus session ${session.id} names an unmaterialized workspace`)
    let latestTurnMessageIds: string[] = []
    let latestTurnContentSha256: Record<string, string> = {}
    let latestTurnTextPartSha256: Record<string, string> = {}
    let latestTurnPartIds: string[] = []
    const displayTitle = /^\d+\.\s/.test(session.title) ? session.title : `${session.order + 1}. ${session.title}`
    database.addSession({
      id: sessionId,
      projectId: home.projectId,
      directory: home.directory,
      title: displayTitle,
      created: sessionTime,
      updated: sessionTime + 999_999 + session.order * 60_000,
    })
    for (const turn of session.turns.toSorted((a, b) => a.index - b.index)) {
      let parentId: string | undefined
      const turnMessageIds: string[] = []
      const turnPartIds: string[] = []
      const turnTextPartSha256: Record<string, string> = {}
      const turnContentSha256: Record<string, string> = {}
      for (const message of turn.messages.toSorted((a, b) => a.order - b.order)) {
        if (message.role === "system") continue
        const at = sessionTime + turn.index * 10_000 + message.order * 1_000
        const messageId = createId("msg", at)
        const data =
          message.role === "user"
            ? {
                role: "user",
                time: { created: at },
                agent: "build",
                model: { providerID: "benchmark", modelID: "deterministic" },
                summary: { diffs: [] },
              }
            : {
                role: "assistant",
                time: { created: at, completed: at + 999 },
                parentID: parentId ?? messageId,
                agent: "build",
                providerID: "benchmark",
                modelID: "deterministic",
                mode: "build",
                path: { cwd: home.directory, root: home.directory },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                finish: "stop",
              }
        database.addMessage(messageId, sessionId, data)
        if (message.role === "user") parentId = messageId
        for (const part of message.parts.toSorted((a, b) => a.order - b.order)) {
          const partId = createId("prt", at + part.order)
          if (materializedParts.has(part.id)) throw new Error(`duplicate corpus part id: ${part.id}`)
          const payload = toOpenCodePart(part, at)
          if (
            message.role === "assistant" &&
            turnMessageIds.length === 0 &&
            payload.type === "text" &&
            typeof payload.text === "string" &&
            payload.text.trim()
          ) {
            turnMessageIds.push(messageId)
            // A message-level content sha only when the payload is an
            // ORIGINAL plain-text corpus part — converted markdown/code/
            // table/diff parts render transformed, so their raw text can
            // never hash-match painted text. The anchor itself does not
            // need the sha: rows carry part identity for verification.
            if (part.type === "text") {
              turnContentSha256[messageId] = createHash("sha256").update(payload.text.trim()).digest("hex")
            }
          }
          turnPartIds.push(partId)
          // Only ORIGINAL plain-text corpus parts get an exact-content sha:
          // markdown/code/table/diff corpus parts are converted into "text"
          // payloads whose markdown SOURCE the renderer transforms, so their
          // rendered innerText can never hash-match the raw payload. Those
          // verify by part identity + painted text, like tool parts.
          if (part.type === "text" && payload.type === "text" && typeof payload.text === "string") {
            turnTextPartSha256[partId] = createHash("sha256").update(payload.text.trim()).digest("hex")
          }
          database.setPart(partId, messageId, part.order, payload, at + part.order)
          materializedParts.set(part.id, {
            corpusPartId: part.id,
            corpusMessageId: message.id,
            partId,
            messageId,
            sessionId,
            payload,
          })
        }
      }
      latestTurnMessageIds = turnMessageIds
      latestTurnContentSha256 = turnContentSha256
      latestTurnTextPartSha256 = turnTextPartSha256
      latestTurnPartIds = turnPartIds
    }
    if (latestTurnMessageIds.length === 0) {
      throw new Error(`Benchmark session ${session.id} latest turn has no canonical assistant text`)
    }
    readinessTargets.push({
      expectedTextPartSha256: latestTurnTextPartSha256,
      expectedPartIds: latestTurnPartIds,
      sessionId,
      title: displayTitle,
      expectedMessageIds: latestTurnMessageIds,
      expectedContentSha256: latestTurnContentSha256,
    })
  }

  const dbPath = await persistClaxedoCorpus({ dataDirectory: input.dataDirectory, corpus: database })
  const coverage = input.profiles.map((profile) => {
    const unsupportedShapes = profileCoverageFailures(corpus, profile)
    return {
      profile,
      corpusDigestSha256: computedDigest,
      counts: corpus.manifest.counts,
      semanticSha256: corpus.manifest.hashes.semanticSha256,
      passed: unsupportedShapes.length === 0,
      unsupportedShapes,
    }
  })
  return {
    corpus,
    dbPath,
    workspaces,
    workspaceDirectory,
    coverage,
    sessionIds: corpus.sessions
      .toSorted((a, b) => a.order - b.order)
      .map((session) => materializedSessions.get(session.id)!),
    readinessTargets,
    materializedSessions,
    materializedParts,
  }
}

function profileCoverageFailures(corpus: AgentAppCorpus, profile: AgentAppProfile) {
  const failures: string[] = []
  if (profile === "workspace-core-v1") {
    if (corpus.sessions.length !== 20) failures.push("workspace-session-count")
    if (corpus.sessions.some((session) => session.turns.length === 0)) failures.push("workspace-empty-session")
  }
  if (profile === "resource-core-v1" && corpus.sessions.length !== 20) failures.push("resource-sweep-session-count")
  if (profile === "conversation-rich-v1") {
    if (
      corpus.sessions.some((session) =>
        session.turns.some((turn) => turn.messages.some((message) => message.role === "system")),
      )
    ) {
      failures.push("system-message")
    }
    if (!corpus.sessions.some((session) => session.turns.length >= 3)) failures.push("history-anchor-count")
    if (!corpus.sessions.some((session) => session.events.some((event) => event.type === "message-part-revision"))) {
      failures.push("controlled-stream-events")
    }
  }
  if (
    profile === "terminal-core-v1" &&
    !corpus.sessions.some((session) =>
      session.terminalStreams.some(
        (stream) =>
          Array.isArray(stream.chunks) &&
          stream.chunks.length > 0 &&
          Array.isArray(stream.inputSentinels) &&
          stream.inputSentinels.length > 0,
      ),
    )
  ) {
    failures.push("terminal-stream")
  }
  return failures
}

function toOpenCodePart(part: CorpusPart, at: number): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") }
  if (part.type === "markdown") return { type: "text", text: String(part.markdown ?? "") }
  if (part.type === "code")
    return {
      type: "text",
      text: `\`\`\`${String(part.language)}\n${String(part.code)}\n\`\`\``,
    }
  if (part.type === "table") {
    const headers = part.headers as string[]
    const rows = part.rows as string[][]
    return {
      type: "text",
      text: [
        `| ${headers.join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n"),
    }
  }
  if (part.type === "diff")
    return {
      type: "text",
      text: `### ${String(part.path)}\n\n\`\`\`diff\n${String(part.patch)}\n\`\`\``,
    }
  if (part.type === "reasoning")
    return {
      type: "reasoning",
      text: String(part.text ?? ""),
      time: { start: at, end: at + 999 },
    }
  if (part.type === "attachment") {
    return {
      type: "file",
      mime: String(part.mediaType),
      filename: String(part.name),
      url: TRANSPARENT_PNG,
    }
  }
  if (part.type === "tool") {
    const input = JSON.parse(String(part.inputJson || "{}")) as Record<string, unknown>
    const status = String(part.state)
    const state =
      status === "completed"
        ? {
            status,
            input,
            output: String(part.outputText ?? ""),
            title: String(part.toolName),
            metadata: {},
            time: { start: at, end: at + 999 },
          }
        : status === "error"
          ? {
              status,
              input,
              error: String(part.outputText ?? "error"),
              time: { start: at, end: at + 999 },
            }
          : status === "running"
            ? { status, input, time: { start: at } }
            : { status: "pending", input, raw: String(part.inputJson ?? "{}") }
    return {
      type: "tool",
      callID: String(part.callId),
      tool: String(part.toolName),
      state,
    }
  }
  throw new Error(`unsupported corpus part: ${part.type}`)
}

function parseCorpus(value: unknown): AgentAppCorpus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("corpus must be an object")
  const corpus = value as AgentAppCorpus
  if (corpus.schemaVersion !== 1 || corpus.kind !== "agent-app-corpus" || !Array.isArray(corpus.sessions)) {
    throw new Error("unsupported agent-app corpus")
  }
  return corpus
}

function corpusDigest(corpus: AgentAppCorpus) {
  const { manifest: _, ...payload } = corpus
  return createHash("sha256")
    .update(JSON.stringify(sortJson(payload)))
    .digest("hex")
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwP4WQAAAABJRU5ErkJggg=="
