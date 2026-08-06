/**
 * The scripted model endpoint — the ONE fake thing in a Tier R spec.
 *
 * Everything else in the tier is real: the app, claxedo-server, the embedded
 * OpenCode engine, the claude/codex binaries, the workspace-runtime. This
 * server stands where api.anthropic.com / api.openai.com would, speaking the
 * three wire dialects those real components actually use:
 *
 *   POST …/chat/completions  — OpenAI chat-completions SSE. The embedded
 *     engine's `@ai-sdk/openai-compatible` provider speaks this. Wire shape
 *     ported from `real-workgraph-harness.ts` (sendProviderText/Tool/Events),
 *     which has driven the real engine in the @workgraph-real lane for months.
 *   POST …/messages — Anthropic Messages, streaming SSE and non-stream JSON.
 *     The claude CLI (both ACP and native SDK modes) speaks this when
 *     ANTHROPIC_BASE_URL points here. Shape ported from
 *     `agent-sdk-runtime/script/enforcement-probe.ts`, verified against the
 *     real claude binary.
 *   POST …/responses — OpenAI Responses SSE. codex speaks this when its
 *     `model_providers.*` override (via CODEX_CONFIG) sets
 *     `wire_api="responses"`. Also from enforcement-probe, verified against
 *     the real codex binary.
 *
 * Behavior contract (same across dialects, so one spec journey drives all
 * harnesses):
 *   - A prompt containing "Reply with exactly this one token …: <MARKER>"
 *     returns exactly <MARKER>. This is the turn-oracle handshake.
 *   - "Generate a title for this conversation" returns a fixed title, so the
 *     engine's title turn never leaks into per-turn call counts.
 *   - Everything else returns "ok".
 *   - Tool-loop mode is deliberately NOT the default: Tier R smoke turns are
 *     text-only. `scriptTool()` arms a one-shot tool call for specs that need
 *     to prove the tool round-trip; the loop terminates the way the probe's
 *     does (tool_result / function_call_output present in the transcript).
 *
 * The request log is the spec's supplement-assertion surface: every request
 * is recorded with its dialect, so a spec can assert "3 turns = 3 chat calls"
 * and "zero requests after idle" without touching the wire itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

export type ScriptedDialect = "chat" | "messages" | "responses"

export type ScriptedModelRequest = {
  dialect: ScriptedDialect
  path: string
  model: string
  /** Flattened prompt text the reply was derived from. */
  prompt: string
  /** What the server decided to answer. */
  reply: { kind: "text"; text: string } | { kind: "tool"; name: string; input: unknown }
}

export type ScriptedToolCall = { name: string; input: unknown }

export type ScriptedModelServer = {
  /** Origin without a trailing slash, e.g. http://127.0.0.1:52341 */
  url: string
  /** `${url}/v1` — what OpenAI-shaped provider configs want as baseURL. */
  v1Url: string
  port: number
  requests: ScriptedModelRequest[]
  /** Requests per dialect since start (or last resetCounts). */
  counts(): Record<ScriptedDialect, number>
  resetCounts(): void
  /**
   * Arm a one-shot tool call: the next non-title request whose transcript does
   * not already carry the tool's result gets `tool_use` instead of text.
   */
  scriptTool(call: ScriptedToolCall): void
  /**
   * Hold every subsequent reply for `ms` before writing it — OFF (0) by
   * default so no existing spec slows down. The request is still counted and
   * pushed to `requests` IMMEDIATELY on receipt (see the handler below), only
   * the response write is delayed — this is what lets a caller assert
   * "counter already non-zero" and "status still shows busy" as two
   * genuinely distinct, orderable moments instead of a near-zero-latency
   * busy->idle transition no polling loop can reliably straddle. Set back to
   * 0 (or leave unset) to restore the default instant reply.
   */
  setReplyDelayMs(ms: number): void
  close(): Promise<void>
}

export const SCRIPTED_TITLE = "Scripted Tier R Session"

// The prompt is scanned as JSON-flattened text, so the marker capture must
// stop at token characters — a `\S+` would run into the serialized quote that
// follows and echo transcript JSON back into the reply.
//
// `g`, and the LAST match wins: from turn 2 onward the transcript carries every
// previous turn's prompt too, so a first-match capture answers turn N with turn
// 1's marker forever. That failure is invisible to a single-turn probe and
// looks exactly like a product bug in a multi-turn spec (the reply renders, it
// is simply the wrong turn's text) — which is how it was found.
const MARKER_PROMPT = /reply with exactly this one token[^:]*:\s*\\?"?([A-Za-z0-9._-]+)/gi
const TITLE_PROMPT = "Generate a title for this conversation"

export async function startScriptedModelServer(port = 0): Promise<ScriptedModelServer> {
  const requests: ScriptedModelRequest[] = []
  let counts: Record<ScriptedDialect, number> = { chat: 0, messages: 0, responses: 0 }
  let pendingTool: ScriptedToolCall | undefined
  let sequence = 0
  let replyDelayMs = 0

  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST") {
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    const body = await readJson(incoming)
    const path = incoming.url ?? "/"
    const dialect: ScriptedDialect = path.includes("responses")
      ? "responses"
      : path.includes("messages")
        ? "messages"
        : "chat"
    counts[dialect] += 1
    sequence += 1

    const prompt = promptText(dialect, body)
    const transcript = JSON.stringify(body)
    const toolResultSeen = dialect === "responses"
      ? transcript.includes("function_call_output")
      : dialect === "messages"
        ? transcript.includes('"tool_result"')
        : transcript.includes('"role":"tool"')

    let reply: ScriptedModelRequest["reply"]
    if (prompt.includes(TITLE_PROMPT)) {
      reply = { kind: "text", text: SCRIPTED_TITLE }
    } else if (pendingTool && !toolResultSeen) {
      reply = { kind: "tool", name: pendingTool.name, input: pendingTool.input }
      pendingTool = undefined
    } else {
      const marker = [...prompt.matchAll(MARKER_PROMPT)].at(-1)?.[1]
      reply = { kind: "text", text: marker ?? "ok" }
    }
    requests.push({ dialect, path, model: String(body.model ?? "scripted"), prompt, reply })

    // Counted and recorded ABOVE, before any delay — a caller polling
    // `counts()` sees the hit immediately, regardless of `replyDelayMs`.
    // Only the response WRITE waits, which is what holds the caller (a real
    // `claude`/session turn) in a "busy" state for an assertable window.
    if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs))

    if (dialect === "chat") return respondChat(outgoing, sequence, reply)
    if (dialect === "responses") return respondResponses(outgoing, sequence, body, reply)
    return respondMessages(outgoing, sequence, body, reply)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("scripted model server failed to bind")
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    v1Url: `${url}/v1`,
    port: address.port,
    requests,
    counts: () => ({ ...counts }),
    resetCounts: () => {
      counts = { chat: 0, messages: 0, responses: 0 }
    },
    scriptTool: (call) => {
      pendingTool = call
    },
    setReplyDelayMs: (ms) => {
      replyDelayMs = ms
    },
    close: () => closeAll(server),
  }
}

/**
 * Provider block the embedded OpenCode engine consumes via
 * OPENCODE_CONFIG_CONTENT (v1 config schema, auto-migrated by the engine —
 * same shape the @workgraph-real lane has always used). `options.baseURL` and
 * `options.apiKey` are exactly the two keys the engine's provider layer reads.
 *
 * NOTE FOR ANY FUTURE SCRIPTED MODEL: the composer's model picker HIDES models
 * by default. `visible()` (`src/features/session/providers/models.tsx:117-126`)
 * shows a model only if the user explicitly unhid it, or it is in `latestSet`,
 * or its release date is unknown/unparseable. `latestSet` is derived from the
 * date itself — within 6 months of now (`models.tsx:59-67`), NOT from the
 * `(latest)` name suffix, which `list()` only strips for display. So a fixture
 * model carrying a real-but-old `release_date` is invisible in the picker and
 * the search reports "No model results" — truthfully. This cost a full
 * debugging session: the catalog contained the provider, connected and
 * correctly named, while the picker showed nothing.
 *
 * This block therefore OMITS `release_date` deliberately, taking the
 * unknown-date branch. A pinned recent date would work today and silently rot
 * six months later — a dated time bomb in a test fixture is worse than none.
 */
export function opencodeScriptedProviderConfig(v1Url: string) {
  return {
    formatter: false,
    lsp: false,
    model: "tier-real/scripted-model",
    provider: {
      "tier-real": {
        name: "Tier R Scripted",
        id: "tier-real",
        env: ["TIER_REAL_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "scripted-model": {
            id: "scripted-model",
            name: "Scripted Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            // release_date omitted on purpose — see this function's doc.
            variants: { high: {} },
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: v1Url },
      },
    },
  }
}

/**
 * CODEX_CONFIG env value that redirects codex at the scripted endpoint.
 * codex ignores OPENAI_BASE_URL entirely in ChatGPT auth mode — a
 * model_providers override is the only way in (enforcement-probe's finding,
 * verified against the real binary). Same shape `codexAcpLaunch` would build
 * from `-c` args, emitted directly as the JSON env var it produces.
 */
export function codexScriptedConfigJson(v1Url: string) {
  return JSON.stringify({
    model_provider: "scripted",
    model_providers: {
      scripted: {
        name: "scripted",
        base_url: v1Url,
        wire_api: "responses",
        env_key: "OPENAI_API_KEY",
        requires_openai_auth: false,
      },
    },
  })
}

/**
 * The `config.toml` body for a scratch `CODEX_HOME` that redirects codex at the
 * scripted endpoint.
 *
 * This — not `CODEX_CONFIG` — is what actually redirects the codex CLI.
 * `CODEX_CONFIG` is a convention of the `@agentclientprotocol/codex-acp`
 * WRAPPER (its `startAcpServer()` reads `process.env.CODEX_CONFIG`); the codex
 * binary itself has no such env var, and `codex-app-server` never sees it at
 * all because the native driver spawns `codex app-server` with no `-c`
 * override. With only `CODEX_CONFIG` set, BOTH codex harnesses silently fall
 * through to the developer's real `~/.codex/config.toml` — verified: a Tier R
 * run rendered three correct markers while this server logged zero requests,
 * answered by the `model` pinned in the real config, on the machine owner's
 * quota. Writing this file into a scratch home and setting `CODEX_HOME` (which
 * `CodexDriver` already honors) redirects both variants with no product
 * change, verified against the real binary.
 *
 * The model id must be one THIS codex build ships metadata for. An invented id
 * like `scripted-model` is not harmless: `codex-acp` surfaces "Model metadata
 * for `<id>` not found. Defaulting to fallback metadata" as the assistant
 * turn's ONLY content and never emits the reply, so the turn renders as a
 * warning paragraph with no answer and the oracle correctly fails. The id here
 * is only a string the scripted server echoes back — it never reaches a real
 * provider — so naming a real one costs nothing and keeps the harness on its
 * normal path.
 *
 * Probed against the installed binary: `gpt-5.1-codex` and `gpt-5-codex` both
 * still warn; `gpt-5.6-sol` is clean. If a codex upgrade retires that id, this
 * default needs re-probing — the symptom will be a codex scenario whose only
 * assistant content is the metadata warning.
 */
export function codexScriptedConfigToml(v1Url: string, model = "gpt-5.6-sol") {
  return `model_provider = "scripted"
model = "${model}"

[model_providers.scripted]
name = "scripted"
base_url = "${v1Url}"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
`
}

/**
 * Env vars that point the claude CLI (ACP and native SDK) at the endpoint.
 *
 * `configDir` is REQUIRED and must be a scratch directory: the CLI's own
 * `settings.json` `env` block overrides the process environment, so a
 * developer whose global settings set `ANTHROPIC_BASE_URL` (a local proxy, a
 * gateway) would silently hijack the turn — the scripted server sees zero
 * requests while the test goes green against the wrong backend. Isolating
 * `CLAUDE_CONFIG_DIR` is what makes the redirect trustworthy.
 */
export function claudeScriptedEnv(url: string, configDir: string) {
  return {
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_API_BASE_URL: url,
    ANTHROPIC_API_KEY: "test-key",
    // Claude Code has multiple auth branches. Current builds can still prefer
    // the machine's persisted claude.ai OAuth session unless the OAuth slot is
    // explicitly occupied, even when ANTHROPIC_AUTH_TOKEN is present. Set all
    // supported slots to the same inert fixture token: the real CLI still runs,
    // while every request must authenticate only against the redirected server.
    ANTHROPIC_AUTH_TOKEN: "test-key",
    CLAUDE_CODE_OAUTH_TOKEN: "test-key",
    // Remote/admin settings can union environment keys into a long-running
    // Claude process after spawn. In a redirect test the launch environment is
    // the authority; allowing a fetched base URL to replace it is both flaky
    // and capable of sending the inert fixture key to the real endpoint.
    CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: configDir,
  }
}

// ---------------------------------------------------------------------------
// Dialect emitters. Wire shapes are ports, not inventions — see file header.
// ---------------------------------------------------------------------------

function respondChat(outgoing: ServerResponse, sequence: number, reply: ScriptedModelRequest["reply"]) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const events =
    reply.kind === "text"
      ? [
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: reply.text } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage },
        ]
      : [
          { choices: [{ delta: { role: "assistant" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: `call_${sequence}`, type: "function", function: { name: reply.name, arguments: "" } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.input) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
        ]
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  events.forEach((event) => outgoing.write(`data: ${JSON.stringify(event)}\n\n`))
  outgoing.end("data: [DONE]\n\n")
}

function respondMessages(
  outgoing: ServerResponse,
  sequence: number,
  body: Record<string, unknown>,
  reply: ScriptedModelRequest["reply"],
) {
  const content =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text }]
      : [{ type: "tool_use", id: `toolu_scripted_${sequence}`, name: reply.name, input: reply.input }]
  const stop = reply.kind === "text" ? "end_turn" : "tool_use"

  if (!body.stream) {
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(
      JSON.stringify({
        id: `msg_${sequence}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "scripted",
        content,
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    return
  }

  const events: string[] = [
    frame("message_start", {
      type: "message_start",
      message: {
        id: `msg_${sequence}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "scripted",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  ]
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }))
      events.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: (block as { text: string }).text } }))
    } else {
      const tool = block as { id: string; name: string; input: unknown }
      events.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } }))
      events.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }))
    }
    events.push(frame("content_block_stop", { type: "content_block_stop", index }))
  })
  events.push(frame("message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } }))
  events.push(frame("message_stop", { type: "message_stop" }))
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  outgoing.end(events.join(""))
}

function respondResponses(
  outgoing: ServerResponse,
  sequence: number,
  body: Record<string, unknown>,
  reply: ScriptedModelRequest["reply"],
) {
  const item =
    reply.kind === "text"
      ? {
          type: "message",
          id: `msg_${sequence}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply.text }],
        }
      : {
          type: "function_call",
          id: `fc_${sequence}`,
          call_id: `call_${sequence}`,
          name: reply.name,
          arguments: JSON.stringify(reply.input),
          status: "completed",
        }
  const response = {
    id: `resp_${sequence}`,
    object: "response",
    status: "completed",
    model: body.model ?? "scripted",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  // The FULL streamed delta sequence, not just created/done/completed.
  //
  // This is load-bearing for codex-acp and was proven by A/B against the real
  // binaries: codex's `app-server` only emits `item/agentMessage/delta` — the
  // notification `@agentclientprotocol/codex-acp` converts into an ACP
  // `agent_message_chunk` (its `createTextEvent`, reached from
  // `case "item/agentMessage/delta"`) — when it SEES the text streamed as
  // `output_text.delta`. With the terminal-only shape this emitter used to
  // send, `codex app-server` completed the turn with correct token usage and
  // emitted NO delta at all, so the wrapper forwarded no assistant text and the
  // reply never reached the UI. Confirmed both directions: streamed shape ->
  // `item/agentMessage/delta` present; terminal-only shape -> absent.
  //
  // Note the `codex exec` CLI is NOT a proxy for this — it parses the
  // terminal-only shape happily and prints the text, which is why the gap
  // looked like a wrapper bug until the app-server protocol was driven
  // directly. Any future edit here must keep the delta frames.
  const streamed =
    reply.kind === "text"
      ? [
          frame("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { type: "message", id: `msg_${sequence}`, role: "assistant", status: "in_progress", content: [] },
          }),
          frame("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: 2,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
          frame("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: 3,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            delta: reply.text,
            logprobs: [],
          }),
          frame("response.output_text.done", {
            type: "response.output_text.done",
            sequence_number: 4,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            text: reply.text,
            logprobs: [],
          }),
          frame("response.content_part.done", {
            type: "response.content_part.done",
            sequence_number: 5,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: reply.text, annotations: [] },
          }),
        ]
      : []
  const sse = [
    frame("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
    ...streamed,
    frame("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
    frame("response.completed", { type: "response.completed", response }),
  ].join("")
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  outgoing.end(sse)
}

function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Flatten the prompt text out of whichever transcript shape the dialect uses.
 * String-scan rather than schema-walk: system blocks, content arrays, and
 * plain strings all carry the marker as a substring, and the marker regex
 * needs nothing more.
 */
function promptText(dialect: ScriptedDialect, body: Record<string, unknown>) {
  const source = dialect === "responses" ? body.input : body.messages
  return JSON.stringify(source ?? body)
}

async function readJson(incoming: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function closeAll(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
