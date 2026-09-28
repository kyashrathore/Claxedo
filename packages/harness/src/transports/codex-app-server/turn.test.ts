import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { TurnBroker, TurnInput } from "../../contract"
import { scriptedTransport } from "./test-support/transport"

const turnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
  prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Delegate" }] }, todos: [] } as TurnInput

const createSubagent = { id: "mcp-spawn-1", type: "mcpToolCall", server: "claxedo", tool: "create_subagent", status: "completed",
  arguments: { harness: "claude", prompt: "Consult" },
  result: { content: [{ type: "text", text: JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9" }) }] } }

test("a turn's create_subagent result is observed as its spawn before the turn ends", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const observed: SubagentObservation[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const broker = { signal: new AbortController().signal,
      observeSubagent: async (observation: SubagentObservation) => { await held; observed.push(observation); return undefined } } as unknown as TurnBroker
    let ended = false
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, broker)) {} })().finally(() => { ended = true })
    await peer.started
    const threadId = session.binding.upstreamSessionId
    peer.emit({ method: "item/completed", params: { threadId, turnId: "turn-current", item: createSubagent } })
    peer.emit({ method: "turn/completed", params: { threadId, turn: { id: "turn-current", status: "completed" } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ended).toBe(false)
    release()
    await running
    expect(observed).toMatchObject([{ subagentKey: "subagent_host", toolCallId: "mcp-spawn-1", toolCallRole: "spawn", childSessionId: "child-9" }])
  } finally { await peer.close() }
})

async function failedTurnError(credentials?: Record<string, unknown>) {
  const peer = await scriptedTransport()
  try {
    const startInput = credentials ? { ...peer.startInput, credentials: { ...peer.startInput.credentials, ...credentials } } : peer.startInput
    const session = await peer.transport.start(startInput, peer.liveBroker())
    const events: unknown[] = []
    const running = (async () => {
      for await (const routed of peer.transport.send(session, turnInput, { signal: new AbortController().signal } as TurnBroker)) events.push(routed.event)
    })()
    await peer.started
    peer.emit({ method: "turn/completed", params: { threadId: session.binding.upstreamSessionId,
      turn: { id: "turn-current", status: "failed", error: { message: "Too many requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } } } } })
    await running
    return events.find((event) => (event as { type?: string }).type === "error")
  } finally { await peer.close() }
}

test("a failed Codex turn names the account it ran on: this computer's login, or the stored credential it was bound to", async () => {
  expect(await failedTurnError()).toMatchObject({ type: "error", error: "Too many requests", errorClass: "rate_limit", account: { kind: "machine", harnessId: "codex" } })
  const account = { credentialId: "cred-1", providerId: "codex-app-server", label: "work" }
  expect(await failedTurnError({ machineLoginAllowed: false, providers: { "codex-app-server": {
    baseUrl: "http://127.0.0.1:1/bindings/b1", apiPath: "/v1", placeholder: "placeholder", authMode: "bearer", account } } }))
    .toMatchObject({ type: "error", account: { kind: "stored", harnessId: "codex", ...account } })
})
