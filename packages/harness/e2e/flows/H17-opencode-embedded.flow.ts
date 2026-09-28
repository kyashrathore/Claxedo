import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000
  do {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  throw new Error(`H17 timed out waiting for ${label}`)
}

async function idle(stream: EventStream, sessionId: string, since: number) {
  await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId
    && stream.frames.indexOf(frame) >= since, { label: "H17 OpenCode idle", timeoutMs: 60_000 })
}

export async function run() {
  const stack = await startStack({ label: "h17-opencode-embedded" })
  let release = () => {}
  try {
    const configDirectory = path.join(stack.dataDir, ".config", "opencode")
    await fs.mkdir(configDirectory, { recursive: true })
    await fs.writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ permission: { shell: "ask", question: "allow" } }))
    await stack.daemon.restart()
    const { directory } = await stack.daemon.makeWorkspace("h17-opencode")
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    const model = { providerId: "openai", modelId: "scripted" }
    const session = await api.createSession(directory, { harness: { id: "opencode", access: "native" }, model })
    const failures: string[] = []
    try {
      const file = path.join(stack.dataDir, "h17-permission.txt")
      stack.scripted.scriptTool({ name: "shell", whenPromptIncludes: "H17PERMISSION",
        input: { command: `printf approved > '${file}'` } })
      const permissionSince = stream.frames.length
      await api.promptAsync(directory, session.id, "Use shell to write H17PERMISSION, then reply H17PERMISSION")
      const permission = await until(async () => {
        const row = (await api.permissions(directory)).find((item) => item.sessionID === session.id)
        if (row) return row
        const current = await api.session(directory, session.id)
        if (current.lastTurn?.status === "failed") {
          throw new Error(`C-11: OpenCode permission turn failed before asking: ${current.lastTurn.error}; model requests: ${stack.scripted.requests.length}`)
        }
        if (stream.frames.some((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id
          && stream.frames.indexOf(frame) >= permissionSince)) {
          throw new Error(`H-23: OpenCode permission mode shell=ask, question=allow; shell tool call ${JSON.stringify(stack.scripted.requests.filter((request) => request.prompt.includes("H17PERMISSION")).map((request) => request.reply))} ended without a permission request; last turn: ${JSON.stringify(current.lastTurn)}`)
        }
        return undefined
      }, "permission")
      assert.ok(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id))
      await api.replyPermission(directory, session.id, permission.id, "once")
      await idle(stream, session.id, 0)
      assert.equal(await fs.readFile(file, "utf8"), "approved")
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }

    try {
      stack.scripted.scriptTool({ name: "question", whenPromptIncludes: "H17QUESTION", input: { questions: [
        { header: "Choice", question: "Continue H17?", options: [
          { label: "Yes", description: "Continue" }, { label: "No", description: "Stop" },
        ] },
      ] } })
      const questionSince = stream.frames.length
      await api.promptAsync(directory, session.id, "Ask H17QUESTION, then reply H17QUESTION")
      const question = await until(async () => {
        const row = (await api.questions(directory)).find((item) => item.sessionID === session.id)
        if (row) return row
        if (stream.frames.some((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id
          && stream.frames.indexOf(frame) >= questionSince)) throw new Error("question turn ended without asking")
        return undefined
      }, "question")
      await api.replyQuestion(directory, question.id, [["Yes"]])
      await idle(stream, session.id, questionSince)
      if (!stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id)) {
        failures.push(`H-23: OpenCode question was answered and stored but no live question.asked frame appeared; answer: ${JSON.stringify(stack.scripted.requests.filter((request) => request.prompt.includes("Yes")).map((request) => request.reply))}`)
      }
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("Yes") && request.dialect === "chat"))
    } catch (error) { failures.push(`H-23: today's OpenCode question path: ${error instanceof Error ? error.message : String(error)}`) }

    try {
      release = stack.scripted.holdTextReplies("H17INFLIGHT")
      const heldSince = stream.frames.length
      await api.promptAsync(directory, session.id, "Reply with exactly H17INFLIGHT")
      const first = await until(async () => stack.scripted.requests.find((request) => request.prompt.includes("H17INFLIGHT")
        && request.dialect === "chat"), "held model request")
      const stored = await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/credentials`, {
        provider_id: "openai", kind: "api_key", source: "local_only", secret: "h17-renewed-scripted-key",
      }, "Store renewed OpenCode account")
      const id = (JSON.parse(stored) as { credential: { id: string } }).credential.id
      await sendJson(directTransport, "POST", `${stack.url}/api/claxedo/credentials/activate`, { ids: [id] }, "Activate renewed OpenCode account")
      if (process.env.CLAXEDO_E2E_REFUSE_RENEWED_CREDENTIAL === "1") stack.scripted.refuseAuthorization("h17-renewed-scripted-key")
      release()
      await idle(stream, session.id, heldSince)
      const nextSince = stream.frames.length
      await api.promptAsync(directory, session.id, "Reply with exactly this one token: H17ROTATED")
      await idle(stream, session.id, nextSince)
      const next = stack.scripted.requests.find((request) => request.prompt.includes("H17ROTATED") && request.dialect === "chat")
      assert.ok(next, "C-11: OpenCode's next request did not reach the scripted model")
      assert.notEqual(first.authorization, next.authorization, "C-11: OpenCode kept the prior account")
      assert.ok(next.authorization?.includes("h17-renewed-scripted-key"), "C-11: OpenCode omitted the renewed account")
      assert.match(assistantText(await api.messages(directory, session.id)), /H17ROTATED/)
      assert.equal((await api.session(directory, session.id)).id, session.id)
      assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    } catch (error) { failures.push(`C-11: today's OpenCode credential path: ${error instanceof Error ? error.message : String(error)}`) }
    if (failures.length) throw new Error(failures.join("; "))
  } finally {
    release()
    await stack.close()
  }
}
