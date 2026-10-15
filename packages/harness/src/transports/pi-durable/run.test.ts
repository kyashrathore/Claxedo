import { expect, test } from "bun:test"
import { EDGE_REFUSED_MESSAGE } from "@claxedo/agent-runtime-contract"
import type { SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable"
import type { RoutedEvent } from "../../contract"
import { PiRun } from "./run"

const BLOCK_PAGE = `<!DOCTYPE html>
<html lang="en-US"><head><title>Unable to load site</title></head>
<body><p>Please try again later. If you are using a VPN, try turning it off.</p>
<p>[IP:2a06:98c0:3600::103 | Ray ID:a4abfe3368bcce65]</p></body></html>`

const input = 1 as SubmissionId

async function terminal(record: SubmissionRecord): Promise<RoutedEvent["event"][]> {
  const run = new PiRun("ses-1", { ask: async () => ({}) as never, signal: () => undefined } as never, { inputs: [input] })
  run.receive({ type: "submission", record } as never, [])
  run.endBatch()
  const events: RoutedEvent["event"][] = []
  for await (const item of run.queue) events.push(item.event)
  return events
}

test("a model error that is the vendor edge's block page ends the turn as a refused connection, never as its markup", async () => {
  expect(await terminal({ id: input, conversationId: "c" as never, type: "input", status: "unanswered", reason: "model_error", detail: BLOCK_PAGE } as SubmissionRecord))
    .toEqual([{ type: "error", error: EDGE_REFUSED_MESSAGE, errorClass: "egress" }])
})

test("any other model error ends the turn with Pi's own words and leaves the class to them", async () => {
  expect(await terminal({ id: input, conversationId: "c" as never, type: "input", status: "unanswered", reason: "model_error", detail: "429: rate limit exceeded" } as SubmissionRecord))
    .toEqual([{ type: "error", error: "429: rate limit exceeded" }])
  expect(await terminal({ id: input, conversationId: "c" as never, type: "input", status: "unanswered", reason: "faulted" } as SubmissionRecord))
    .toEqual([{ type: "error", error: "Pi left the turn unanswered: faulted" }])
})
