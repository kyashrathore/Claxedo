import type { ServerResponse } from "node:http"
import type { ContentBlock, Message, MessageCreateParams, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages"
import type { ChatCompletionChunk } from "openai/resources/chat/completions"
import type {
  Response as OpenAIResponse,
  ResponseCreateParams,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses"

export type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown; namespace?: string }
  | { kind: "error"; status: number; message: string }

export type StreamPacing = { chunks: number; delayMs: number }
type StreamedReply = Exclude<ScriptedReply, { kind: "error" }>
type MessageBlock = Extract<ContentBlock, { type: "text" | "tool_use" }>

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" }

export function textDeltaChunks(text: string, chunks: number) {
  const pieces = Math.max(1, Math.min(chunks, text.length))
  const size = Math.ceil(text.length / pieces)
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out.length ? out : [text]
}

function deltas(text: string, pacing?: StreamPacing) {
  return pacing ? textDeltaChunks(text, pacing.chunks) : [text]
}

export function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

async function writeTextStream<T extends { type: string }>(
  outgoing: ServerResponse,
  events: T[],
  isTextDelta: (event: T) => boolean,
  pacing?: StreamPacing,
) {
  let emittedText = false
  for (const event of events) {
    if (isTextDelta(event)) {
      if (emittedText && pacing) await new Promise((resolve) => setTimeout(resolve, pacing.delayMs))
      emittedText = true
    }
    if (outgoing.destroyed) return
    outgoing.write(frame(event.type, event))
  }
  outgoing.end()
}

export function writeErrorReply(outgoing: ServerResponse, reply: Extract<ScriptedReply, { kind: "error" }>) {
  outgoing.writeHead(reply.status, { "content-type": "application/json" })
  outgoing.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.message } }))
}

function chatChunks(sequence: number, reply: StreamedReply, pacing?: StreamPacing): ChatCompletionChunk[] {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const chunk = (choices: ChatCompletionChunk["choices"], includeUsage = false): ChatCompletionChunk => ({
    id: `chatcmpl_${sequence}`,
    choices,
    created: 0,
    model: "scripted",
    object: "chat.completion.chunk",
    ...(includeUsage ? { usage } : {}),
  })
  if (reply.kind === "text") {
    return [
      chunk([{ delta: { role: "assistant" }, finish_reason: null, index: 0 }]),
      ...deltas(reply.text, pacing).map((content) => chunk([{ delta: { content }, finish_reason: null, index: 0 }])),
      chunk([{ delta: {}, finish_reason: "stop", index: 0 }], true),
    ]
  }
  const call = { index: 0, id: `call_${sequence}`, type: "function" as const, function: { name: reply.name, arguments: "" } }
  return [
    chunk([{ delta: { role: "assistant" }, finish_reason: null, index: 0 }]),
    chunk([{ delta: { tool_calls: [call] }, finish_reason: null, index: 0 }]),
    chunk([{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.input) } }] }, finish_reason: null, index: 0 }]),
    chunk([{ delta: {}, finish_reason: "tool_calls", index: 0 }], true),
  ]
}

export async function respondChat(outgoing: ServerResponse, sequence: number, reply: StreamedReply, pacing?: StreamPacing) {
  const events = chatChunks(sequence, reply, pacing)
  const textCount = reply.kind === "text" ? deltas(reply.text, pacing).length : 0
  outgoing.writeHead(200, { ...SSE_HEADERS, connection: "keep-alive" })
  for (const [index, event] of events.entries()) {
    if (pacing && index > 1 && index <= textCount) await new Promise((resolve) => setTimeout(resolve, pacing.delayMs))
    outgoing.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  outgoing.end("data: [DONE]\n\n")
}

function anthropicMessage(sequence: number, body: MessageCreateParams, stop: Message["stop_reason"], blocks: MessageBlock[]): Message {
  return {
    id: `msg_${sequence}`,
    container: null,
    type: "message",
    role: "assistant",
    model: body.model ?? "scripted",
    content: blocks,
    stop_details: null,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  }
}

function anthropicBlockEvents(block: MessageBlock, index: number, pacing?: StreamPacing): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = []
  if (block.type === "text") {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } })
    for (const text of deltas(block.text, pacing)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } })
  } else {
    events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } })
    events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
  }
  events.push({ type: "content_block_stop", index })
  return events
}

export async function respondMessages(
  outgoing: ServerResponse,
  sequence: number,
  body: MessageCreateParams,
  reply: StreamedReply,
  pacing?: StreamPacing,
) {
  const content: MessageBlock[] = reply.kind === "text"
    ? [{ type: "text", text: reply.text, citations: null }]
    : [{ type: "tool_use", id: `toolu_scripted_${sequence}`, name: reply.name, input: reply.input, caller: { type: "direct" } }]
  const stop: Message["stop_reason"] = reply.kind === "text" ? "end_turn" : "tool_use"
  if (!body.stream) {
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(JSON.stringify(anthropicMessage(sequence, body, stop, content)))
    return
  }
  const events: RawMessageStreamEvent[] = [
    { type: "message_start", message: anthropicMessage(sequence, body, null, []) },
    ...content.flatMap((block, index) => anthropicBlockEvents(block, index, pacing)),
    {
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
    },
    { type: "message_stop" },
  ]
  outgoing.writeHead(200, SSE_HEADERS)
  await writeTextStream(outgoing, events, (event) => event.type === "content_block_delta" && event.delta.type === "text_delta", pacing)
}

function responsesEnvelope(sequence: number, body: ResponseCreateParams, reply: StreamedReply, status: OpenAIResponse["status"], output: ResponseOutputItem[]): OpenAIResponse {
  return {
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
  }
}

function responsesTextEvents(sequence: number, text: string, pacing?: StreamPacing): ResponseStreamEvent[] {
  const itemId = `msg_${sequence}`
  const part = (value: string) => ({ type: "output_text" as const, text: value, annotations: [], logprobs: [] })
  return [
    { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 0, item_id: itemId, output_index: 0, content_index: 0, part: part("") },
    ...deltas(text, pacing).map((delta) => ({ type: "response.output_text.delta" as const, sequence_number: 0, item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: [] })),
    { type: "response.output_text.done", sequence_number: 0, item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: "response.content_part.done", sequence_number: 0, item_id: itemId, output_index: 0, content_index: 0, part: part(text) },
  ]
}

function responsesToolEvents(item: Extract<ResponseOutputItem, { type: "function_call" }>): ResponseStreamEvent[] {
  const itemId = item.id ?? item.call_id
  return [
    { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", sequence_number: 0, item_id: itemId, output_index: 0, delta: item.arguments },
    { type: "response.function_call_arguments.done", sequence_number: 0, item_id: itemId, output_index: 0, name: item.name, arguments: item.arguments },
  ]
}

export async function respondResponses(
  outgoing: ServerResponse,
  sequence: number,
  body: ResponseCreateParams,
  reply: StreamedReply,
  pacing?: StreamPacing,
) {
  const item: ResponseOutputItem = reply.kind === "tool"
    ? {
        type: "function_call",
        id: `fc_${sequence}`,
        call_id: `call_${sequence}`,
        name: reply.name,
        arguments: JSON.stringify(reply.input),
        ...(reply.namespace ? { namespace: reply.namespace } : {}),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${sequence}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply.text, annotations: [], logprobs: [] }],
      }
  const streamed = item.type === "function_call" ? responsesToolEvents(item) : responsesTextEvents(sequence, reply.kind === "text" ? reply.text : "", pacing)
  const events: ResponseStreamEvent[] = [
    { type: "response.created", sequence_number: 0, response: responsesEnvelope(sequence, body, reply, "in_progress", []) },
    ...streamed,
    { type: "response.output_item.done", sequence_number: 0, output_index: 0, item },
    { type: "response.completed", sequence_number: 0, response: responsesEnvelope(sequence, body, reply, "completed", [item]) },
  ]
  events.forEach((event, index) => {
    event.sequence_number = index
  })
  outgoing.writeHead(200, SSE_HEADERS)
  await writeTextStream(outgoing, events, (event) => event.type === "response.output_text.delta", pacing)
}
