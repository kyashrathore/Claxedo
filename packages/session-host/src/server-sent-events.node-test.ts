import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { serverSentEvents } from "./server-sent-events"

function chunkedBody(...chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function read(...chunks: string[]) {
  const events = []
  for await (const event of serverSentEvents(chunkedBody(...chunks))) events.push(event)
  return events
}

void describe("serverSentEvents", () => {
  void it("reads LF, CRLF and CR line ends, a CRLF split across chunks among them", async () => {
    assert.deepEqual(await read("event: output\ndata: {\"text\":\"a\"}\n\n", "event: output\r\ndata: b\r", "\n\r\nevent: result\rdata: c\r\r"), [
      { name: "output", data: "{\"text\":\"a\"}" },
      { name: "output", data: "b" },
      { name: "result", data: "c" },
    ])
  })

  void it("reads the last event when the stream ends without a blank line after it", async () => {
    assert.deepEqual(await read("event: output\ndata: x\n\nevent: result\r\ndata: {\"ok\":true}\r\n"), [
      { name: "output", data: "x" },
      { name: "result", data: "{\"ok\":true}" },
    ])
  })

  void it("joins data lines and names an unnamed event message", async () => {
    assert.deepEqual(await read("data: one\ndata: two\n\n"), [{ name: "message", data: "one\ntwo" }])
  })
})
