// WHAT: Feed two completely different raw harness streams (Claude SDK messages,
//       Codex app-server JSON-RPC) through @claxedo/agent-event-runtime and get
//       ONE canonical AgentRuntimeEvent shape back — no per-harness branching.
// RUN:  bun run recipe:03-one-event-shape   (invokes: npx tsx src/recipes/03-one-event-shape.ts)
// NEEDS: nothing — deterministic replay of real-shaped harness payloads, no live
//        agents, no network, no credentials.
// WOW:  A Claude `stream_event` and a Codex `item/agentMessage/delta` come out as
//       byte-identical envelopes: { type, harness, threadId, raw, ...fields } —
//       and even garbage input becomes a canonical diagnostic event, never a throw.

import { createAgentEventRuntime, type AgentRuntimeEvent, type RawHarnessEvent } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { codexAppServerAdapter } from "@claxedo/agent-event-runtime/harnesses/codex"
import { banner, printResult } from "./_shared"

banner({
  recipe: "03-one-event-shape",
  what: "two raw harness dialects in -> one canonical AgentRuntimeEvent shape out",
  wow: "identical envelope fields for Claude and Codex, and errors become events, not exceptions",
})

const THREAD_ID = "thread-recipe-03"

// Deterministic runtimes: fixed clock + sequential ids, so this recipe prints
// the same output on every machine.
function deterministic() {
  return { clock: () => 0, createId: (prefix = "id") => `${prefix}-1` }
}

const claude = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: THREAD_ID,
  adapter: claudeSdkAdapter(),
  ...deterministic(),
})

const codex = createAgentEventRuntime({
  harness: "codex-app-server",
  threadId: THREAD_ID,
  adapter: codexAppServerAdapter(),
  ...deterministic(),
})

// ---- the same story, told in two raw dialects -------------------------------
// Payload shapes are copied from the adapters' own test fixtures in
// packages/agent-event-runtime — these are the real wire shapes each harness emits.

const claudeStream: RawHarnessEvent[] = [
  {
    source: "claude.sdk.message",
    payload: {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    },
  },
  {
    source: "claude.sdk.message",
    payload: {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-grep-1", name: "Grep", input: {} },
      },
    },
  },
  {
    source: "claude.sdk.message",
    payload: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"foo\",\"path\":\"src\"}" },
      },
    },
  },
  {
    source: "claude.sdk.message",
    payload: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-grep-1", content: "src/example.ts:1:foo" }],
      },
    },
  },
  {
    source: "claude.sdk.message",
    payload: {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-session-result",
      usage: { input_tokens: 4, cache_creation_input_tokens: 2715, cache_read_input_tokens: 21144, output_tokens: 679 },
      modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
    },
  },
]

const codexStream: RawHarnessEvent[] = [
  {
    source: "codex.app-server",
    method: "item/agentMessage/delta",
    payload: { itemId: "msg-1", delta: "Hi" },
  },
  {
    source: "codex.app-server",
    method: "item/started",
    payload: { item: { id: "cmd-1", type: "commandExecution", command: "grep -rn foo src", cwd: "/repo" } },
  },
  {
    source: "codex.app-server",
    method: "item/completed",
    payload: { item: { id: "cmd-1", type: "commandExecution", aggregatedOutput: "src/example.ts:1:foo" } },
  },
  {
    source: "codex.app-server",
    method: "turn/completed",
    payload: { turn: { status: "completed" } },
  },
]

// ============================ the essential path ============================
// Ingest raw, get canonical. That's it — the UI/store/projections only ever
// see AgentRuntimeEvent, whatever harness produced it.
const claudeEvents = claudeStream.flatMap((raw) => claude.ingest(raw).events)
const codexEvents = codexStream.flatMap((raw) => codex.ingest(raw).events)
// ============================================================================

printResult("canonical events <- claude-sdk raw stream", [
  ...claudeStream.map((raw, i) => `raw[${i}] ${describeRaw(raw)}`),
  "",
  ...claudeEvents.map((event) => `=> ${summarize(event)}`),
].join("\n"))

printResult("canonical events <- codex-app-server raw stream", [
  ...codexStream.map((raw, i) => `raw[${i}] ${describeRaw(raw)}`),
  "",
  ...codexEvents.map((event) => `=> ${summarize(event)}`),
].join("\n"))

// ---- prove the envelope is the same shape on both sides ---------------------
const claudeDelta = claudeEvents.find((event) => event.type === "text-delta")!
const codexDelta = codexEvents.find((event) => event.type === "text-delta")!
const claudeKeys = Object.keys(claudeDelta).sort().join(",")
const codexKeys = Object.keys(codexDelta).sort().join(",")
const allEvents = [...claudeEvents, ...codexEvents]
const envelopeOnEvery = allEvents.every(
  (event) => typeof event.type === "string" && typeof event.harness === "string"
    && typeof event.threadId === "string" && typeof event.raw?.source === "string",
)

printResult("envelope parity: same 'text-delta', two harnesses", table([
  ["field", "claude-sdk", "codex-app-server"],
  ["type", claudeDelta.type, codexDelta.type],
  ["delta", JSON.stringify(claudeDelta.type === "text-delta" ? claudeDelta.delta : ""), JSON.stringify(codexDelta.type === "text-delta" ? codexDelta.delta : "")],
  ["harness", claudeDelta.harness ?? "", codexDelta.harness ?? ""],
  ["threadId", claudeDelta.threadId ?? "", codexDelta.threadId ?? ""],
  ["raw.source", claudeDelta.raw?.source ?? "", codexDelta.raw?.source ?? ""],
  ["object keys", claudeKeys, codexKeys],
]) + `\nidentical key set: ${claudeKeys === codexKeys}`
  + `\nall ${allEvents.length} events carry { type, harness, threadId, raw }: ${envelopeOnEvery}`)

// ---- the contract even covers failure: bad input -> diagnostic EVENT --------
// An unknown payload and an adapter exception both come back as canonical
// `diagnostic` events with the same envelope. Consumers never need try/catch
// around a harness stream.
const unknownPayload = claude.ingest({
  source: "claude.sdk.message",
  payload: { type: "banana", peel: true },
}).events
const adapterException = codex.ingest({
  source: "codex.app-server",
  // no `method` -> the codex adapter throws internally; the runtime converts
  // the exception into a `runtime.adapter_error` diagnostic event.
  payload: { anything: "goes" },
}).events

printResult("diagnostic contract: bad input is still one event shape", [
  `unknown claude payload => ${summarize(unknownPayload[0]!)}`,
  `  code=${diagnosticCode(unknownPayload[0]!)}`,
  `codex adapter exception => ${summarize(adapterException[0]!)}`,
  `  code=${diagnosticCode(adapterException[0]!)}`,
  `both are type="diagnostic" with the same envelope: ${[...unknownPayload, ...adapterException]
    .every((event) => event.type === "diagnostic" && !!event.harness && !!event.threadId && !!event.raw)}`,
].join("\n"))

if (claudeKeys !== codexKeys || !envelopeOnEvery) {
  console.error("FAIL: envelope shapes diverged between harnesses")
  process.exit(1)
}
console.log("one event shape, two harnesses, zero per-harness branching. done.")

// ---- helpers ---------------------------------------------------------------

/** One-line label for a raw harness event: source, method, payload type. */
function describeRaw(raw: RawHarnessEvent): string {
  const payload = raw.payload as { type?: string; event?: { type?: string } } | undefined
  const inner = [raw.method ?? payload?.type, payload?.event?.type].filter(Boolean).join(".")
  return `${raw.source}  ${inner}`
}

/** One-line canonical event: type + payload fields (envelope proven separately). */
function summarize(event: AgentRuntimeEvent): string {
  const { harness: _h, threadId: _t, raw: _r, type, ...rest } = event as Record<string, unknown> & AgentRuntimeEvent
  delete (rest as Record<string, unknown>).display
  delete (rest as Record<string, unknown>).metadata
  const body = JSON.stringify(rest)
  return `${type.padEnd(15)} ${body.length > 78 ? `${body.slice(0, 75)}...` : body}`
}

function diagnosticCode(event: AgentRuntimeEvent): string {
  return event.type === "diagnostic" ? event.diagnostic.code : "(not a diagnostic)"
}

/** Tiny fixed-width table for the docs output. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)))
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  | ").trimEnd()).join("\n")
}
