import assert from "node:assert/strict"
import { ClaxedoApi, ApiError, type PermissionRow } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readPermissionReceipts } from "../harness/acp/receipts"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

async function pending(api: ClaxedoApi, stream: EventStream, directory: string, sessionId: string, title: string): Promise<PermissionRow> {
  await stream.waitFor((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === sessionId
    && (frame.data.payload as { properties?: { metadata?: { title?: string } } }).properties?.metadata?.title === title,
    { label: `permission ${title}` })
  const row = (await api.permissions(directory)).find((item) =>
    item.sessionID === sessionId && (item.metadata as { title?: string } | undefined)?.title === title)
  assert.ok(row, `Permission ${title} was not pending after permission.asked`)
  return row
}

async function refused(call: () => Promise<unknown>, status: number) {
  await assert.rejects(call, (error: unknown) => error instanceof ApiError && error.status === status)
}

function permissionFrames(stream: EventStream, sessionId: string, type: string) {
  return stream.frames.filter((frame) => {
    if (frameType(frame) !== type) return false
    const properties = (frame.data.payload as { properties?: { sessionID?: string } } | undefined)?.properties
    return properties?.sessionID === sessionId
  })
}

export async function run() {
  const stack = await startStack({ label: "h3-permissions" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h3-permissions")
    const directory = workspace.directory
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H3 permissions" })
    await stack.acp.write("h3-once", { steps: [{ kind: "permission", tool: "execute", title: "Run once", text: "once allowed" }] })
    const onceSince = stream.frames.length
    await api.promptAsync(directory, session.id, acpScriptToken("h3-once"))
    const once = await pending(api, stream, directory, session.id, "Run once")
    const other = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H3 foreign owner" })
    await stack.acp.write("h3-foreign", { steps: [{ kind: "permission", tool: "read", title: "Other session request" }] })
    await api.promptAsync(directory, other.id, acpScriptToken("h3-foreign"))
    const foreign = await pending(api, stream, directory, other.id, "Other session request")
    const beforeForeign = await readPermissionReceipts(stack.acp.scriptDir)
    await refused(() => api.replyPermission(directory, session.id, foreign.id, "once"), 404)
    assert.deepEqual(await readPermissionReceipts(stack.acp.scriptDir), beforeForeign, "foreign reply reached the agent")
    await api.replyPermission(directory, other.id, foreign.id, "reject")
    await api.replyPermission(directory, session.id, once.id, "once")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id
      && stream.frames.indexOf(frame) >= onceSince, { label: "once turn idle" })
    const afterOnce = await readPermissionReceipts(stack.acp.scriptDir)
    assert.equal(afterOnce.find((row) => row.title === "Run once")?.optionId, "allow-once")
    await refused(() => api.replyPermission(directory, session.id, once.id, "once"), 404)
    assert.deepEqual(await readPermissionReceipts(stack.acp.scriptDir), afterOnce, "duplicate reply reached the agent")

    await stack.acp.write("h3-always", { steps: [
      { kind: "permission", tool: "execute", title: "Same command", input: { command: "make check" }, text: "first allowed" },
      { kind: "permission", tool: "execute", title: "Same command", input: { command: "make check" }, text: "second allowed" },
      { kind: "permission", tool: "execute", title: "Different command", input: { command: "make clean" }, text: "third allowed" },
    ] })
    const alwaysSince = stream.frames.length
    await api.promptAsync(directory, session.id, acpScriptToken("h3-always"))
    const always = await pending(api, stream, directory, session.id, "Same command")
    await api.replyPermission(directory, session.id, always.id, "always")
    const different = await pending(api, stream, directory, session.id, "Different command")
    assert.equal((await api.permissions(directory)).filter((row) => row.sessionID === session.id).length, 1,
      "identical second call prompted despite the session grant")
    const granted = await readPermissionReceipts(stack.acp.scriptDir)
    assert.equal(granted.filter((row) => row.title === "Same command").length, 2,
      "the agent did not receive both identical calls")
    assert.equal(granted.find((row) => row.title === "Same command")?.optionId, "allow-always")
    await api.replyPermission(directory, session.id, different.id, "once")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id
      && stream.frames.indexOf(frame) >= alwaysSince && permissionFrames(stream, session.id, "permission.replied").length >= 3,
      { label: "always turn idle" })

    await stack.acp.write("h3-deny", { steps: [{ kind: "permission", tool: "execute", title: "Denied command" }] })
    const denySince = stream.frames.length
    await api.promptAsync(directory, session.id, acpScriptToken("h3-deny"))
    const deny = await pending(api, stream, directory, session.id, "Denied command")
    await api.replyPermission(directory, session.id, deny.id, "reject")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id
      && stream.frames.indexOf(frame) >= denySince && permissionFrames(stream, session.id, "permission.replied").length >= 4,
      { label: "deny turn idle" })
    const afterDeny = await readPermissionReceipts(stack.acp.scriptDir)
    assert.equal(afterDeny.find((row) => row.title === "Denied command")?.optionId, "reject-once")
    await refused(() => api.replyPermission(directory, session.id, deny.id, "reject"), 404)
    assert.deepEqual(await readPermissionReceipts(stack.acp.scriptDir), afterDeny, "stale reply reached the agent")

    assert.equal((await api.permissions(directory)).filter((row) => row.sessionID === session.id).length, 0)
    assert.equal((await api.session(directory, session.id)).id, session.id)
    const messages = await api.messages(directory, session.id)
    const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    assert.ok(tools.some((part) => (part.state as { status?: string } | undefined)?.status === "completed"))
    assert.ok(tools.some((part) => (part.state as { status?: string } | undefined)?.status === "error"))
    assert.equal(permissionFrames(stream, session.id, "permission.asked").length, 4)
    assert.equal(permissionFrames(stream, session.id, "permission.replied").length, 5)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H3 ACP: once, always, deny, refused 404 replies; live frames, stored tools, session and permission readbacks passed")
  } finally {
    await stack.close()
  }
}
