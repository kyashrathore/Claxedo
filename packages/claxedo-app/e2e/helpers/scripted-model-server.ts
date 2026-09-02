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
import type {
  ContentBlock,
  Message,
  MessageCreateParams,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages"
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from "openai/resources/chat/completions"
import type {
  Response as OpenAIResponse,
  ResponseCreateParams,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses"

export type ScriptedDialect = "chat" | "messages" | "responses"

export type ScriptedModelRequest = {
  dialect: ScriptedDialect
  path: string
  /** Full provider request, typed from the official Anthropic/OpenAI SDK. */
  body: ChatCompletionCreateParams | MessageCreateParams | ResponseCreateParams
  model: string
  /** Flattened prompt text the reply was derived from. */
  prompt: string
  /** What the server decided to answer. */
  reply: { kind: "text"; text: string } | { kind: "tool"; name: string; input: unknown; namespace?: string }
  /** Tool definitions advertised by the real harness in this provider request. */
  tools: { name: string; inputSchema?: unknown }[]
}

export type ScriptedToolCall = { name: string; input: unknown; namespace?: string; whenPromptIncludes?: string }

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
const GOAL_EVALUATOR_PROMPT = "You are an independent completion evaluator."
const CLAUDE_GOAL_EVALUATOR_PROMPT = "Based on the conversation transcript above, has the following stopping condition been satisfied?"

function isClaudeGoalEvaluatorPrompt(prompt: string) {
  return prompt.includes(CLAUDE_GOAL_EVALUATOR_PROMPT)
}

function isGoalEvaluatorPrompt(prompt: string) {
  // Anthropic Messages carries the evaluator instruction in top-level
  // `system`, while promptText intentionally flattens only `messages`. The
  // evaluator's two user headings are stable across the OpenCode and Pi owned
  // executors and distinguish it from the worker continuation prompt.
  return prompt.includes(GOAL_EVALUATOR_PROMPT)
    || (prompt.includes("OBJECTIVE:") && prompt.includes("LATEST WORK RESULT:"))
}

type ScriptedModelBody =
  | { dialect: "chat"; body: ChatCompletionCreateParams }
  | { dialect: "messages"; body: MessageCreateParams }
  | { dialect: "responses"; body: ResponseCreateParams }
type ScriptedMessageBlock = Extract<ContentBlock, { type: "text" | "tool_use" }>

export async function startScriptedModelServer(port = 0): Promise<ScriptedModelServer> {
  const requests: ScriptedModelRequest[] = []
  let counts: Record<ScriptedDialect, number> = { chat: 0, messages: 0, responses: 0 }
  let pendingTool: ScriptedToolCall | undefined
  let goalEvaluationCount = 0
  let sequence = 0
  let replyDelayMs = 0

  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST") {
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    const path = incoming.url ?? "/"
    const dialect: ScriptedDialect = path.includes("responses")
      ? "responses"
      : path.includes("messages")
        ? "messages"
        : "chat"
    const request = modelRequestBody(dialect, await readJson(incoming))
    const body = request.body
    counts[request.dialect] += 1
    sequence += 1

    const prompt = promptText(request)
    const toolResultSeen = hasToolResult(request)

    let reply: ScriptedModelRequest["reply"]
    if (prompt.includes(TITLE_PROMPT)) {
      reply = { kind: "text", text: SCRIPTED_TITLE }
    } else if (isClaudeGoalEvaluatorPrompt(prompt)) {
      goalEvaluationCount += 1
      reply = goalEvaluationCount === 1
        ? { kind: "text", text: JSON.stringify({ ok: false, reason: "One more autonomous iteration is required" }) }
        : { kind: "text", text: JSON.stringify({ ok: true }) }
    } else if (isGoalEvaluatorPrompt(prompt)) {
      goalEvaluationCount += 1
      reply = goalEvaluationCount === 1
        ? { kind: "text", text: JSON.stringify({ met: false, reason: "One more autonomous iteration is required" }) }
        : { kind: "text", text: JSON.stringify({ met: true, reason: "The scripted continuation supplied the required evidence" }) }
    } else if (pendingTool && (pendingTool.whenPromptIncludes
      ? prompt.includes(pendingTool.whenPromptIncludes)
      : !toolResultSeen)) {
      reply = {
        kind: "tool",
        name: pendingTool.name,
        input: pendingTool.input,
        ...(pendingTool.namespace ? { namespace: pendingTool.namespace } : {}),
      }
      pendingTool = undefined
    } else {
      const marker = [...prompt.matchAll(MARKER_PROMPT)].at(-1)?.[1]
      reply = { kind: "text", text: marker ?? "ok" }
    }
    requests.push({ dialect: request.dialect, path, body, model: body.model ?? "scripted", prompt, reply, tools: modelTools(body) })

    // Counted and recorded ABOVE, before any delay — a caller polling
    // `counts()` sees the hit immediately, regardless of `replyDelayMs`.
    // Only the response WRITE waits, which is what holds the caller (a real
    // `claude`/session turn) in a "busy" state for an assertable window.
    if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs))

    if (request.dialect === "chat") return respondChat(outgoing, sequence, reply)
    if (request.dialect === "responses") return respondResponses(outgoing, sequence, request.body, reply)
    return respondMessages(outgoing, sequence, request.body, reply)
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
      goalEvaluationCount = 0
      requests.splice(0)
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
 * by default. `resolveModelVisibility`
 * (`src/features/session/providers/models.tsx`) shows a model only when the
 * user explicitly unhid it, or it IS the provider's default model —
 * `providers.default()[providerID] === modelID`, served by `/provider` from
 * `Provider.defaultModelIDs` (`sort(models)[0]`). The picker lists CONNECTED
 * providers only, so a scripted provider reaches it through exactly the one
 * model that sort picks: keep this block at ONE model and the question never
 * arises.
 *
 * `release_date` is irrelevant to that rule and is omitted only because nothing
 * here needs it. (It used to be load-bearing: visibility was once derived from
 * a "released within 6 months" set, so a real-but-old date made the model
 * invisible and the search truthfully reported "No model results". That rule is
 * gone — do not spend a debugging session on the date again.)
 */
export function opencodeScriptedProviderConfig(v1Url: string) {
  return {
    formatter: false,
    lsp: false,
    model: "tier-real/scripted-model",
    permission: { task: "allow" },
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
            // No release_date: nothing in the picker or the engine reads one
            // for this fixture — see this function's doc.
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
    features: {
      multi_agent: true,
      multi_agent_v2: { enabled: true, non_code_mode_only: true, tool_namespace: "agents" },
    },
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

[features]
multi_agent = true

[features.multi_agent_v2]
enabled = true
non_code_mode_only = true
tool_namespace = "agents"

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
  const chunk = (choices: ChatCompletionChunk["choices"], includeUsage = false): ChatCompletionChunk => ({
    id: `chatcmpl_${sequence}`,
    choices,
    created: 0,
    model: "scripted",
    object: "chat.completion.chunk",
    ...(includeUsage ? { usage } : {}),
  })
  const events: ChatCompletionChunk[] =
    reply.kind === "text"
      ? [
          chunk([{ delta: { role: "assistant" }, finish_reason: null, index: 0 }]),
          chunk([{ delta: { content: reply.text }, finish_reason: null, index: 0 }]),
          chunk([{ delta: {}, finish_reason: "stop", index: 0 }], true),
        ]
      : [
          chunk([{ delta: { role: "assistant" }, finish_reason: null, index: 0 }]),
          chunk([{
            delta: {
              tool_calls: [
                { index: 0, id: `call_${sequence}`, type: "function", function: { name: reply.name, arguments: "" } },
              ],
            },
            finish_reason: null,
            index: 0,
          }]),
          chunk([{
            delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.input) } }] },
            finish_reason: null,
            index: 0,
          }]),
          chunk([{ delta: {}, finish_reason: "tool_calls", index: 0 }], true),
        ]
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  events.forEach((event) => outgoing.write(`data: ${JSON.stringify(event)}\n\n`))
  outgoing.end("data: [DONE]\n\n")
}

function respondMessages(
  outgoing: ServerResponse,
  sequence: number,
  body: MessageCreateParams,
  reply: ScriptedModelRequest["reply"],
) {
  const content: ScriptedMessageBlock[] =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text, citations: null }]
      : [{
          type: "tool_use",
          id: `toolu_scripted_${sequence}`,
          name: reply.name,
          input: reply.input,
          caller: { type: "direct" },
        }]
  const stop = reply.kind === "text" ? "end_turn" : "tool_use"
  const usage: Message["usage"] = {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 1,
    output_tokens: 1,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
  }
  const message = (stopReason: Message["stop_reason"], blocks = content): Message => ({
    id: `msg_${sequence}`,
    container: null,
    type: "message",
    role: "assistant",
    model: body.model ?? "scripted",
    content: blocks,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  })

  if (!body.stream) {
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(JSON.stringify(message(stop)))
    return
  }

  const events: RawMessageStreamEvent[] = [
    {
      type: "message_start",
      message: message(null, []),
    },
  ]
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      })
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { ...block, input: {} },
      })
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      })
    }
    events.push({ type: "content_block_stop", index })
  })
  events.push({
    type: "message_delta",
    delta: { container: null, stop_details: null, stop_reason: stop, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
    },
  })
  events.push({ type: "message_stop" })
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  outgoing.end(events.map((event) => frame(event.type, event)).join(""))
}

function respondResponses(
  outgoing: ServerResponse,
  sequence: number,
  body: ResponseCreateParams,
  reply: ScriptedModelRequest["reply"],
) {
  const toolItem = reply.kind === "tool"
    ? {
          type: "function_call",
          id: `fc_${sequence}`,
          call_id: `call_${sequence}`,
          name: reply.name,
          arguments: JSON.stringify(reply.input),
          ...(reply.namespace ? { namespace: reply.namespace } : {}),
          status: "completed",
        } satisfies Extract<ResponseOutputItem, { type: "function_call" }>
    : undefined
  const item: ResponseOutputItem = toolItem ?? {
    type: "message",
    id: `msg_${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: reply.kind === "text" ? reply.text : "", annotations: [], logprobs: [] }],
  }
  const response = (status: OpenAIResponse["status"], output: ResponseOutputItem[]): OpenAIResponse => ({
    id: `resp_${sequence}`,
    created_at: 0,
    output_text: reply.kind === "text" ? reply.text : "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    object: "response",
    status,
    model: body.model ?? "scripted",
    output,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  })
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
  const streamed: ResponseStreamEvent[] =
    reply.kind === "text"
      ? [
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { type: "message", id: `msg_${sequence}`, role: "assistant", status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            sequence_number: 2,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            delta: reply.text,
            logprobs: [],
          },
          {
            type: "response.output_text.done",
            sequence_number: 4,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            text: reply.text,
            logprobs: [],
          },
          {
            type: "response.content_part.done",
            sequence_number: 5,
            item_id: `msg_${sequence}`,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: reply.text, annotations: [], logprobs: [] },
          },
        ]
      : toolItem ? [
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { ...toolItem, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 2,
            item_id: toolItem.id,
            output_index: 0,
            delta: toolItem.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 3,
            item_id: toolItem.id,
            output_index: 0,
            name: toolItem.name,
            arguments: toolItem.arguments,
          },
        ] : []
  const events: ResponseStreamEvent[] = [
    { type: "response.created", sequence_number: 0, response: response("in_progress", []) },
    ...streamed,
    { type: "response.output_item.done", sequence_number: 6, output_index: 0, item },
    { type: "response.completed", sequence_number: 7, response: response("completed", [item]) },
  ]
  outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  outgoing.end(events.map((event) => frame(event.type, event)).join(""))
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
function promptText(request: ScriptedModelBody) {
  const source = request.dialect === "responses" ? request.body.input : request.body.messages
  return JSON.stringify(source ?? request.body)
}

function hasToolResult(request: ScriptedModelBody) {
  if (request.dialect === "responses") {
    return Array.isArray(request.body.input) && request.body.input.some((item) => record(item)?.type === "function_call_output")
  }
  if (request.dialect === "messages") {
    return request.body.messages.some((message) =>
      Array.isArray(message.content) && message.content.some((block) => record(block)?.type === "tool_result"))
  }
  return request.body.messages.some((message) => message.role === "tool")
}

function modelRequestBody(dialect: ScriptedDialect, input: unknown): ScriptedModelBody {
  const body = record(input) ?? {}
  const model = typeof body.model === "string" && body.model ? body.model : "scripted"
  if (dialect === "responses") {
    return {
      dialect,
      body: {
        ...body,
        model,
        input: body.input ?? "",
      } as ResponseCreateParams,
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (dialect === "messages") {
    return {
      dialect,
      body: {
        ...body,
        model,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1,
        messages,
      } as MessageCreateParams,
    }
  }
  return {
    dialect,
    body: {
      ...body,
      model,
      messages,
    } as ChatCompletionCreateParams,
  }
}

function modelTools(body: ScriptedModelBody["body"]) {
  return (body.tools ?? []).flatMap((tool) => {
    const row = record(tool)
    const fn = record(row?.function)
    const name = typeof row?.name === "string"
      ? row.name
      : typeof fn?.name === "string"
        ? fn.name
        : undefined
    return name ? [{ name, ...(row?.input_schema ? { inputSchema: row.input_schema } : fn?.parameters ? { inputSchema: fn.parameters } : {}) }] : []
  })
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

async function readJson(incoming: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
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
