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

test("every usage the turn reports, its children's included, names the account its tokens were spent on", async () => {
  const account = { kind: "stored", harnessId: "claude", credentialId: "cred_team", providerId: "anthropic" } as const
  const tokens = { input: 3, output: 1, reasoning: null, cache: { read: null, write: null } }
  const events: RoutedEvent[] = [
    { event: { type: "usage", contextSize: 0, contextUsed: 3, observation: { kind: "delta", tokens } } },
    { event: { type: "usage", contextSize: 0, contextUsed: 3, observation: { kind: "delta", tokens } }, route: { kind: "child", correlationKey: "c1" } },
  ]
  expect(await stamped(events, account)).toEqual(events.map((routed) => ({ ...routed, event: { ...routed.event, account } })))
})
