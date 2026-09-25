import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText, type MessagePart } from "../harness/api"
import { readCapturedAcpPrompt } from "../harness/acp/capture"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { liveParts, waitForIdle } from "../harness/turn-observations"
import { frameSessionId, frameType } from "../harness/stream"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lp8AAAAASUVORK5CYII="
const TEXT = "H11 text attachment reached the harness\n"
const TEXT_BASE64 = Buffer.from(TEXT).toString("base64")

function parts(marker: string): MessagePart[] {
  return [
    { type: "text", text: `Review the image and text file. Reply with exactly this one token: ${marker}` },
    { type: "file", mime: "image/png", filename: "h11.png", url: `data:image/png;base64,${PNG}` },
    { type: "file", mime: "text/plain", filename: "h11.txt", url: `data:text/plain;base64,${TEXT_BASE64}` },
  ]
}

function assertStoredAttachments(messages: Awaited<ReturnType<ClaxedoApi["messages"]>>, stream: Awaited<ReturnType<Stack["events"]>>, sessionId: string) {
  const user = messages.find((message) => message.info.role === "user")
  assert.ok(user, "no stored user message")
  const files = user.parts.filter((part) => part.type === "file")
  assert.equal(files.length, 2, `stored attachment count: ${JSON.stringify(user.parts)}`)
  assert.deepEqual(files.map((file) => String(file.filename)).sort((a, b) => a.localeCompare(b)), ["h11.png", "h11.txt"])
  assert.ok(files.some((file) => file.mime === "image/png" && String(file.url).includes(PNG)), "stored image bytes differ")
  assert.ok(files.some((file) => file.mime === "text/plain" && String(file.url).includes(TEXT_BASE64)), "stored text bytes differ")
  const live = liveParts(stream, sessionId)
  for (const file of files) {
    const filename = String(file.filename)
    assert.ok(file.id, `stored ${filename} user part has no id`)
    const frame = live.get(file.id)
    assert.ok(frame, `H11 live user-part frame missing for ${filename}`)
    assert.equal(frame.type, "file")
    assert.equal(frame.filename, file.filename)
    assert.equal(frame.mime, file.mime)
    assert.equal(frame.url, file.url)
  }
}

async function acpAttachments(stack: Stack, api: ClaxedoApi) {
  const directory = (await stack.daemon.makeWorkspace("h11-acp")).directory
  await stack.acp.write("h11-attachments", { capturePrompt: true, steps: [{ kind: "text", text: "H11_ACP_OK" }] })
  const stream = await stack.events(directory)
  const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS })
  const sent = parts("H11_ACP_OK")
  sent[0].text += ` ${acpScriptToken("h11-attachments")}`
  await api.promptParts(directory, session.id, sent)
  await waitForIdle(stream, session.id)
  const prompt = await readCapturedAcpPrompt(stack.acp.scriptDir, "h11-attachments")
  assert.ok(prompt.some((block) => block.type === "image" && block.data === PNG), "ACP agent did not receive image bytes")
  const resource = prompt.find((block) => block.type === "resource") as { resource?: { mimeType?: string; blob?: string } } | undefined
  assert.ok(resource?.resource?.mimeType === "text/plain" && resource.resource.blob === TEXT_BASE64, `ACP agent did not receive text bytes: ${JSON.stringify(prompt)}`)
  const messages = await api.messages(directory, session.id)
  assertStoredAttachments(messages, stream, session.id)
  assert.match(assistantText(messages), /H11_ACP_OK/)
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log("H11 ACP: image and text bytes reached agent, user attachments persisted, reply streamed, session readback passed")
}

async function nativeAttachments(stack: Stack, api: ClaxedoApi, harness: "claude" | "codex") {
  const directory = (await stack.daemon.makeWorkspace(`h11-${harness}`)).directory
  const stream = await stack.events(directory)
  const session = await api.createSession(directory, { harness: { id: harness, access: "native" } })
  const marker = `H11_${harness.toUpperCase()}_OK`
  const before = stack.scripted.requests.length
  await api.promptParts(directory, session.id, parts(marker))
  await waitForIdle(stream, session.id)
  const messages = await api.messages(directory, session.id)
  assertStoredAttachments(messages, stream, session.id)
  assert.match(assistantText(messages), new RegExp(marker))
  const requests = stack.scripted.requests.slice(before)
  assert.ok(requests.some((request) => request.prompt.includes(marker)), `${harness} did not reach scripted model`)
  const attachmentDir = path.join(directory, ".claxedo", "attachments")
  const attached = await fs.readdir(attachmentDir)
  for (const [filename, contents] of [["h11.png", Buffer.from(PNG, "base64")], ["h11.txt", Buffer.from(TEXT)]] as const) {
    const storedName = attached.find((entry) => entry.endsWith(filename))
    assert.ok(storedName, `${harness} ${filename} was not materialized for the CLI`)
    const absolute = path.join(attachmentDir, storedName)
    assert.deepEqual(await fs.readFile(absolute), contents, `${harness} ${filename} bytes changed before CLI delivery`)
    assert.ok(requests.some((request) => request.prompt.includes(absolute)), `${harness} model input did not reference ${filename}`)
  }
  if (harness === "claude") assert.ok(requests.some((request) => request.prompt.includes(PNG)), "Claude image bytes did not reach the scripted model")
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log(`H11 ${harness}: both attachments reached model input, persisted, reply streamed, session readback passed`)
}

async function piAttachments(stack: Stack, api: ClaxedoApi) {
  const directory = (await stack.daemon.makeWorkspace("h11-pi")).directory
  const stream = await stack.events(directory)
  const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
  const marker = "H11_PI_OK"
  const refused = await api.createSession(directory, { harness: { id: "pi", access: "native" }, model })
  await api.promptParts(directory, refused.id, parts("H11_PI_UNSUPPORTED"), { model })
  await stream.waitFor((frame) => frameType(frame) === "session.error" && frameSessionId(frame) === refused.id, { label: "Pi text-file refusal", timeoutMs: 15_000 })
  const refusal = await api.messages(directory, refused.id)
  assertStoredAttachments(refusal, stream, refused.id)
  assert.match(JSON.stringify(refusal.at(-1)?.info.error), /Pi attachments require an inline base64 image/)
  assert.equal((await api.session(directory, refused.id)).id, refused.id)

  const session = await api.createSession(directory, { harness: { id: "pi", access: "native" }, model })
  const before = stack.scripted.requests.length
  await api.promptParts(directory, session.id, parts(marker).slice(0, 2), { model })
  await waitForIdle(stream, session.id)
  const messages = await api.messages(directory, session.id)
  assert.ok(messages[0]?.parts.some((part) => part.type === "file" && part.mime === "image/png" && String(part.url).includes(PNG)), "Pi image was not stored")
  const image = messages[0]?.parts.find((part) => part.type === "file" && part.mime === "image/png")
  assert.ok(image, "Pi image user part missing")
  assert.ok(image.id, "Pi image user part has no id")
  assert.deepEqual(liveParts(stream, session.id).get(image.id), image, "Pi live image user-part frame differs from stored part")
  assert.match(assistantText(messages), new RegExp(marker))
  const requests = stack.scripted.requests.slice(before)
  assert.ok(requests.some((request) => request.prompt.includes(PNG)), "Pi did not pass image to scripted model")
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log("H11 Pi: image reached model; text file refusal is live and stored; session readback passed")
}

export async function run() {
  const stack = await startStack({ label: "h11-attachments" })
  try {
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    await acpAttachments(stack, api)
    await piAttachments(stack, api)
    for (const harness of ["claude", "codex"] as const) await nativeAttachments(stack, api, harness)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
  } finally {
    await stack.close()
  }
}
