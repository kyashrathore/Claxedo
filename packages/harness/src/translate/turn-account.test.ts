import { expect, test } from "bun:test"
import type { RoutedEvent } from "../contract"
import { withTurnAccount } from "./turn-account"

async function stamped(events: RoutedEvent[], account: Parameters<typeof withTurnAccount>[1]) {
  const out: RoutedEvent[] = []
  for await (const routed of withTurnAccount((async function* () { yield* events })(), account)) out.push(routed)
  return out
}

test("the turn's own error names its account, and a child's error or any other event is left as the harness sent it", async () => {
  const account = { kind: "machine", harnessId: "pi" } as const
  const events: RoutedEvent[] = [
    { event: { type: "session-status", status: "error" } },
    { event: { type: "error", error: "429" }, route: { kind: "parent" } },
    { event: { type: "error", error: "child failed" }, route: { kind: "child", correlationKey: "c1" } },
  ]
  expect(await stamped(events, account)).toEqual([
    events[0]!,
    { event: { type: "error", error: "429", account }, route: { kind: "parent" } },
    events[2]!,
  ])
  expect(await stamped(events, undefined)).toEqual(events)
})
