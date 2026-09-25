import assert from "node:assert/strict"
import { ClaxedoApi, ApiError, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

async function waitFor(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function codexModelAndEffort() {
  const stack = await startStack({ label: "h10-codex-config" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h10-codex-config")
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, model: { providerId: "codex", modelId: "gpt-5.5" }, title: "H10 Codex config",
    })
    await api.prompt(workspace.directory, session.id, "First Codex configuration turn H10FIRST")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "first Codex turn idle", timeoutMs: 60_000 })
    const initial = stack.scripted.requests.filter((request) => request.dialect === "responses" && request.prompt.includes("H10FIRST"))
    assert.ok(initial.length, "first turn must reach the local Codex model")
    const options = (await api.configOptions(workspace.directory, session.id)).options
    const modelOption = options.find((option) => option.id === "model")
    const nextModel = modelOption?.selectOptions?.find((option) => option.id !== modelOption.currentValue)?.id
    assert.ok(nextModel, `Codex must offer a second model: ${JSON.stringify(options)}`)
    const effortOption = (await api.configOptions(workspace.directory, session.id, nextModel)).options.find((option) => option.id === "effort")
    const nextEffort = effortOption?.selectOptions?.find((option) => option.id !== effortOption.currentValue)?.id
    assert.ok(nextEffort, `Codex must offer a second effort for ${nextModel}`)
    const patched = await api.updateSessionConfig(workspace.directory, session.id, { model: { providerID: "codex", modelID: nextModel }, variant: nextEffort })
    assert.deepEqual(patched.model, { providerID: "codex", modelID: nextModel })
    assert.equal(patched.variant, nextEffort)
    const mode = await api.permissionMode(workspace.directory, session.id)
    assert.equal(mode.appliesFrom, "next-turn")
    const selected = mode.modes.find((candidate) => candidate.id === "full-access")
    assert.ok(selected, "Codex must advertise full-access")
    assert.equal((await api.setPermissionMode(workspace.directory, session.id, selected.id)).currentModeId, selected.id)
    assert.equal((await api.permissionMode(workspace.directory, session.id)).currentModeId, selected.id)
    const frameCount = stream.frames.length
    stack.scripted.scriptText({ marker: "H10SECOND", text: "H10SECOND" })
    await api.prompt(workspace.directory, session.id, "Second Codex configuration turn H10SECOND")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id && stream.frames.indexOf(frame) >= frameCount, { label: "second Codex turn idle", timeoutMs: 60_000 })
    const next = stack.scripted.requests.find((request) => request.dialect === "responses" && request.prompt.includes("H10SECOND"))
    assert.equal(next?.model, nextModel, "the next turn must use the patched model")
    assert.equal((next?.body as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort, nextEffort, "the next turn must use the patched effort")
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H10SECOND/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H10 Codex: model, effort, and permission selection applied at the next turn")
  } finally {
    await stack.close()
  }
}

async function credentialRenewalAndChildCeiling() {
  const stack = await startStack({ label: "h10-credential-renewal" })
  let release = () => {}
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h10-credential-renewal")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "claude", modelId: "claude-sonnet-4-6" }
    const session = await api.createSession(workspace.directory, { harness: { id: "claude", access: "native" }, model, title: "H10 long session", permissionMode: "default" })
    assert.equal((await api.permissionMode(workspace.directory, session.id)).appliesFrom, "next-turn")
    await assert.rejects(
      api.createSession(workspace.directory, { harness: { id: "claude", access: "native" }, parentId: session.id, model, permissionMode: "bypassPermissions" }),
      (error: unknown) => error instanceof ApiError && error.status === 403 && error.body.includes("permission_ceiling_exceeded"),
      "a child must not widen the parent's permission mode",
    )
    const child = await api.createSession(workspace.directory, { harness: { id: "claude", access: "native" }, parentId: session.id, model })
    await assert.rejects(
      api.setPermissionMode(workspace.directory, child.id, "bypassPermissions"),
      (error: unknown) => error instanceof ApiError && error.status === 403 && error.body.includes("permission_ceiling_exceeded"),
    )
    assert.equal((await api.session(workspace.directory, child.id)).parentID, session.id)
    release = stack.scripted.holdTextReplies("H10LONG")
    await api.promptAsync(workspace.directory, session.id, "Long credential session H10LONG")
    await waitFor(() => stack.scripted.requests.some((request) => request.prompt.includes("H10LONG") && request.dialect === "messages"), "long session model request")
    const first = stack.scripted.requests.find((request) => request.prompt.includes("H10LONG") && request.dialect === "messages")
    assert.ok(first, "long turn must reach the local model")
    const stored = await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/credentials`, {
      provider_id: "claude-sdk", kind: "api_key", source: "local_only", secret: "renewed-scripted-key",
    }, "Store renewed Claude key")
    const id = (JSON.parse(stored) as { credential: { id: string } }).credential.id
    await sendJson(directTransport, "POST", `${stack.url}/api/claxedo/credentials/activate`, { ids: [id] }, "Activate renewed Claude key")
    const active = await directTransport({ method: "GET", url: `${stack.url}/api/claxedo/credentials/claude-sdk` })
    assert.equal(active.status, 200)
    assert.equal((JSON.parse(active.body) as { credential: { id: string } }).credential.id, id)
    release()
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "long session first turn idle", timeoutMs: 60_000 })
    stack.scripted.scriptText({ marker: "H10RENEWED", text: "H10RENEWED" })
    if (process.env.CLAXEDO_E2E_REFUSE_RENEWED_CREDENTIAL === "1") stack.scripted.refuseAuthorization("renewed-scripted-key")
    await api.prompt(workspace.directory, session.id, "Renewed credential next turn H10RENEWED", { model }).catch((error: unknown) => {
      assert.fail(`Renewed credential must be accepted on the next turn: ${String(error)}`)
    })
    const next = stack.scripted.requests.find((request) => request.prompt.includes("H10RENEWED") && request.dialect === "messages")
    assert.ok(next)
    assert.ok(next?.authorization?.includes("renewed-scripted-key"), "next turn must use the renewed stored credential")
    assert.notEqual(first.authorization, next.authorization)
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H10RENEWED/, "renewed credential must produce a stored next-turn response")
    assert.equal((await api.setPermissionMode(workspace.directory, session.id, "bypassPermissions")).appliesFrom, "next-turn")
    stack.scripted.scriptTool({ name: "Bash", input: { command: "pwd" }, whenPromptIncludes: "H10PERMISSION" })
    await api.prompt(workspace.directory, session.id, "Run Bash pwd under the selected permission mode H10PERMISSION", { model })
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("H10PERMISSION") && JSON.stringify(request.body).includes("tool_result")), "the next turn must execute Bash under the selected mode")
    assert.deepEqual((await api.permissions(workspace.directory)).filter((permission) => permission.sessionID === session.id), [], "bypassPermissions must finish without a pending permission")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H10 Claude: a long session renewed its credential for the next turn and refused child permission widening")
  } finally {
    release()
    await stack.close()
  }
}

export async function run() {
  await codexModelAndEffort()
  await credentialRenewalAndChildCeiling()
}
