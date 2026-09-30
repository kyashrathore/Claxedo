import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText, type MessageRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

/**
 * `held`: the harness gives no evidence of the steer, so it stays uncertain.
 * `incorporated`: Codex still opens the steer's userMessage item when only its
 * `turn/steer` reply is withheld, and that evidence settles the steer.
 */
const CASES = [
  { name: "pi", outcome: "held", model: { providerId: "pi", modelId: "openai/gpt-4.1" } },
  { name: "codex", outcome: "incorporated", model: { providerId: "codex", modelId: "gpt-5.5" } },
  { name: "claude", outcome: "held", model: { providerId: "claude", modelId: "sonnet" } },
] as const

async function nextTurn(stack: Stack, api: ClaxedoApi, directory: string, sessionId: string, name: string) {
  const resumed = await stack.events(directory)
  const next = `H7NEXT${name.toUpperCase()}`
  stack.scripted.scriptText({ marker: next, text: next })
  await api.promptAsync(directory, sessionId, next)
  await resumed.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId, { label: `${name} next turn idle` })
  assert.match(assistantText(await api.messages(directory, sessionId)), new RegExp(next))
  assert.equal((await api.session(directory, sessionId)).lastTurn?.status, "completed")
}

async function unknownCase(item: typeof CASES[number]) {
  const stack = await startStack({ label: `h7-unknown-${item.name}`, ...(item.name === "claude" ? { claudeSteerFault: true } : { steerReplyFault: item.name }) })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace(`h7-unknown-${item.name}`)
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: { id: item.name, access: "native" }, model: item.model })
    const opening = `H7UNKNOWNOPEN${item.name.toUpperCase()}`
    const steered = `H7UNKNOWNSTEER${item.name.toUpperCase()}`
    const release = stack.scripted.holdTextReplies(opening)
    try {
      await api.promptAsync(workspace.directory, session.id, opening)
      const deadline = Date.now() + 20_000
      while (!stack.scripted.requests.some((request) => request.prompt.includes(opening)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(opening)), `${item.name} never reached the scripted model`)
      const route = new URL(`/session/${encodeURIComponent(session.id)}/prompt_async`, stack.url)
      route.searchParams.set("directory", workspace.directory)
      const pending = fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delivery: "steer", parts: [{ type: "text", text: steered }] }) })
      await new Promise((resolve) => setTimeout(resolve, 150))
      release()
      const answer = await pending
      const body = await answer.json() as { status?: string; delivery?: string }
      await stream.waitFor((frame) => (frameType(frame) === "session.idle" || frameType(frame) === "session.error") && frameSessionId(frame) === session.id, { label: `${item.name} unknown steer settled` })
      if (item.name !== "claude") await waitForTitle(stream, session.id)
      const queue = async () => {
        const response = await fetch(new URL(`/session/${encodeURIComponent(session.id)}/queue?directory=${encodeURIComponent(workspace.directory)}`, stack.url))
        assert.equal(response.status, 200)
        return await response.json() as Array<{ seq: number; parts: Array<{ text?: string }>; steering?: { state: string; mode: string } }>
      }
      const storedSteerCount = (messages: MessageRow[]) => messages.filter((message) => message.info.role === "user" && message.parts.some((part) => part.text === steered)).length
      if (item.outcome === "incorporated") {
        assert.equal(answer.status, 200, `${item.name} incorporated steer HTTP: ${JSON.stringify(body)}`)
        assert.deepEqual(body, { delivery: "steer" })
        assert.match(await fs.readFile(path.join(stack.dataDir, `${item.name}-steer-fault-bin`, "seen.log"), "utf8"), /reply withheld/)
        assert.deepEqual(await queue(), [], `${item.name} steer the transcript holds stayed in the queue`)
        assert.equal(storedSteerCount(await api.messages(workspace.directory, session.id)), 1, `${item.name} steered prompt is not in the transcript once`)
        await nextTurn(stack, api, workspace.directory, session.id, item.name)
        assert.equal(storedSteerCount(await api.messages(workspace.directory, session.id)), 1, `${item.name} steered prompt was resent`)
        assert.deepEqual(await queue(), [], `${item.name} queue changed after next turn`)
        assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], `${item.name} attempted outbound egress`)
        console.log(`H7 ${item.name}: withheld steer reply settled by the userMessage item; HTTP 200, one stored steer, empty queue and next completed turn passed`)
        return
      }
      assert.equal(answer.status, 202, `${item.name} unknown steer HTTP: ${JSON.stringify(body)}`)
      assert.ok(body.status === "pending" || body.status === "unknown", `${item.name} steer receipt: ${JSON.stringify(body)}`)
      await stream.waitFor((frame) => {
        const payload = frame.data.payload as { type?: string; sessionID?: string; queue?: Array<{ steering?: { state?: string } }> } | undefined
        return payload?.type === "session.queue" && payload.sessionID === session.id && !!payload.queue?.some((row) => row.steering?.state === "unknown")
      }, { label: `${item.name} uncertain steer held in the queue` })
      const firstRows = await queue()
      assert.ok(firstRows.some((row) => row.parts.some((part) => part.text === steered) && row.steering?.state === "unknown" && row.steering.mode === "steer"), `${item.name} uncertain steer was not held: ${JSON.stringify(firstRows)}`)
      const evidence = await fs.readFile(path.join(stack.dataDir, `${item.name}-steer-fault-bin`, "seen.log"), "utf8")
      assert.match(evidence, item.name === "claude" ? /process interrupted before replay/ : /reply withheld/)
      const firstMessages = await api.messages(workspace.directory, session.id)
      if (item.name === "claude") {
        stream.close()
        await stack.daemon.restart()
        assert.deepEqual(await queue(), firstRows, "Claude unknown steer changed across daemon restart")
        assert.equal(storedSteerCount(await api.messages(workspace.directory, session.id)), storedSteerCount(firstMessages), "Claude resent provider-owned steer on restart")
        assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "failed")
        assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "Claude attempted outbound egress")
        console.log("H7 claude: unknown steer HTTP 202 stayed provider-owned after restart; live failure, stored outcome and queue readback passed")
        return
      }
      await nextTurn(stack, api, workspace.directory, session.id, item.name)
      assert.equal(storedSteerCount(await api.messages(workspace.directory, session.id)), storedSteerCount(firstMessages), `${item.name} stored a second user turn for provider-owned steer`)
      assert.deepEqual(await queue(), firstRows, `${item.name} unknown steer changed after next turn`)
      assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], `${item.name} attempted outbound egress`)
      console.log(`H7 ${item.name}: unknown steer HTTP 202 stayed provider-owned through next completed turn; live, stored and queue readback passed`)
    } finally {
      release()
    }
  } finally {
    await stack.close()
  }
}

export async function run() {
  for (const item of CASES) await unknownCase(item)
}
