/**
 * Mock Anthropic Messages endpoint that always asks to write a file.
 *
 * The ONLY thing faked in the enforcement proof: the agent process, the ACP
 * handshake, the permission machinery and the tool execution are all real. This
 * exists so the model's decision is deterministic — a real model might or might
 * not call a tool, which would make the gated/not-gated comparison meaningless.
 */
const PORT = Number(process.env.PORT ?? 8899)
const DUMP = process.env.DUMP_DIR ?? "/tmp"
let seq = 0

const TOOL = process.env.MOCK_TOOL ?? "Write"
const FILE = process.env.MOCK_FILE ?? "/tmp/enforcement-probe-target.txt"

function toolUseBlocks(id: string) {
  return [
    { type: "text", text: "Writing the file now." },
    { type: "tool_use", id, name: TOOL, input: { file_path: FILE, content: "hi\n" } },
  ]
}

function sse(events: Array<[string, unknown]>) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== "POST") return new Response("ok")

    const raw = await req.text()
    seq += 1
    await Bun.write(`${DUMP}/req-${String(seq).padStart(3, "0")}.json`, raw)
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const tools = (body.tools as Array<{ name?: string }> | undefined)?.map((t) => t.name) ?? []
    console.error(
      `#${seq} ${url.pathname} stream=${body.stream} model=${body.model} tools=${tools.length}:${tools.slice(0, 12).join(",")}`,
    )

    const id = `toolu_probe_${seq}`
    const msgId = `msg_probe_${seq}`

    // After the tool result comes back, stop — otherwise the agent loops forever
    // asking to write the same file. Detect by looking for a tool_result in the
    // conversation we were just sent.
    const msgs = (body.messages as Array<{ content?: unknown }> | undefined) ?? []
    const sawToolResult = JSON.stringify(msgs).includes('"tool_result"')
    const content = sawToolResult ? [{ type: "text", text: "Done." }] : toolUseBlocks(id)
    const stopReason = sawToolResult ? "end_turn" : "tool_use"

    if (body.stream) {
      const events: Array<[string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: body.model ?? "mock",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      ]
      content.forEach((block, index) => {
        if (block.type === "text") {
          events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }])
          events.push([
            "content_block_delta",
            { type: "content_block_delta", index, delta: { type: "text_delta", text: (block as { text: string }).text } },
          ])
        } else {
          const tu = block as { id: string; name: string; input: unknown }
          events.push([
            "content_block_start",
            { type: "content_block_start", index, content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} } },
          ])
          events.push([
            "content_block_delta",
            { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) } },
          ])
        }
        events.push(["content_block_stop", { type: "content_block_stop", index }])
      })
      events.push([
        "message_delta",
        { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
      ])
      events.push(["message_stop", { type: "message_stop" }])
      return new Response(sse(events), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }

    return new Response(
      JSON.stringify({
        id: msgId,
        type: "message",
        role: "assistant",
        model: body.model ?? "mock",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    )
  },
})
console.error(`mock anthropic on http://127.0.0.1:${PORT} (tool=${TOOL} file=${FILE}) dumping to ${DUMP}`)
