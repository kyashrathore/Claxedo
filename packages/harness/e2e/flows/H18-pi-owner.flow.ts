import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

const extension = `export default function (pi) {
  pi.registerCommand("h18-ui", {
    description: "H18 extension UI",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("h18", "H18 status")
      ctx.ui.setWidget("h18", ["H18 widget"])
      pi.sendUserMessage("Reply with exactly this one token: H18EXTENSION")
    },
  })
}
`

async function installProfile(agentDir: string, modelUrl: string, auth: Buffer) {
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true })
  await fs.writeFile(path.join(agentDir, "extensions", "h18.ts"), extension)
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    openai: { baseUrl: modelUrl, apiKey: "h18-scripted" },
  } }))
  await fs.writeFile(path.join(agentDir, "auth.json"), auth)
}

export async function run() {
  const stack = await startStack({ label: "h18-pi-owner" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h18")
    const own = path.join(stack.dataDir, ".pi", "agent")
    const legacy = path.join(stack.dataDir, "agent-core", workspace.id, "pi", "agent")
    const auth = Buffer.from('{"h18":"owner-login-sentinel"}\n')
    await installProfile(own, stack.scripted.v1Url, auth)
    await installProfile(legacy, stack.scripted.v1Url, auth)
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    await api.prompt(workspace.directory, session.id, "Reply with exactly this one token: H18START", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H18 start idle" })
    const commandReply = await fetch(`${stack.url}/command?directory=${encodeURIComponent(workspace.directory)}`)
    if (!commandReply.ok) throw new Error(`H18 command readback failed: ${await commandReply.text()}`)
    const commands = await commandReply.json() as { name?: string }[]
    const frameCount = stream.frames.length
    await api.prompt(workspace.directory, session.id, "/h18-ui", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id &&
      stream.frames.indexOf(frame) >= frameCount, { label: "H18 extension idle" })
    const messages = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(messages), /H18EXTENSION/, "H18 stored extension reply")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id), "H18 live text frame")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id, "H18 session readback")
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("H18EXTENSION")), "H18 scripted model readback")
    const defects: string[] = []
    if (!commands.some((command) => command.name === "h18-ui")) defects.push("H-5: Pi get_commands omitted the owner's extension command")
    const live = JSON.stringify(stream.frames)
    if (!/pi\.extension_ui\.setStatus/.test(live)) defects.push("H-5: Pi dropped setStatus")
    if (!/pi\.extension_ui\.setWidget/.test(live)) defects.push("H-5: Pi dropped setWidget")
    if (!(await fs.readFile(path.join(own, "auth.json"))).equals(auth)) defects.push("H-6: owner auth.json changed")
    if (!(await fs.readFile(path.join(legacy, "auth.json"))).equals(auth)) defects.push("H-6: Claxedo changed the pre-existing Pi profile auth.json")
    assert.deepEqual(stack.egress.attempts, [])
    assert.deepEqual(defects, [], defects.join("\n"))
  } finally { await stack.close() }
}
