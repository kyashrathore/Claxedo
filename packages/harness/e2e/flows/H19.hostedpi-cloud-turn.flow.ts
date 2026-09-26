import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { assistantText } from "../harness/api"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedApi, hostedOwner, hostedSession, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"

export async function run() {
  const stack = await startHostedStack("h19-hosted-pi")
  try {
    const owner = await hostedOwner(stack)
    const stored = await hostedFetch(stack, "/auth/openai?harness=pi", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: { key: "hosted-owner-openai-key" } }),
    }, owner)
    assert.equal(stored.status, 200, `hosted Pi credential: ${await stored.text()}`)
    const workspace = await hostedWorkspace(stack, owner, "H19 hosted Pi")
    const target = JSON.parse(await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspace.id}.json`), "utf8")) as { secretNames: string[]; home: string }
    assert.ok(target.secretNames.includes("CLAXEDO_PROVIDER_OPENAI"), `C-1: hosted Pi sandbox has no OpenAI broker registration: ${JSON.stringify(target.secretNames)}`)
    const offered = await fetch(`${stack.relayUrl}/workspaces/${workspace.id}/api/wr/harness-config-options?nativeHarness=pi`, {
      headers: { authorization: `Bearer ${workspace.runtimeAccessToken}` },
    })
    const offeredBody = await offered.json() as { options?: Array<{ id: string; selectOptions?: Array<{ id: string; connected?: boolean }> }> }
    assert.equal(offered.status, 200, `Hosted Pi model options returned ${offered.status}`)
    const offeredModel = offeredBody.options?.find((option) => option.id === "model")?.selectOptions?.find((choice) => choice.id === "openai/gpt-4.1")
    const modelFiles = (await fs.readdir(target.home, { recursive: true })).filter((name) => name.endsWith("models.json"))
    const modelOverlays = await Promise.all(modelFiles.map(async (file) => {
      const models = JSON.parse(await fs.readFile(path.join(target.home, file), "utf8")) as { providers?: Record<string, { apiKey?: string }> }
      return { file, providers: Object.keys(models.providers ?? {}), brokeredOpenAI: models.providers?.openai?.apiKey === "claxedo-broker:CLAXEDO_PROVIDER_OPENAI" }
    }))
    assert.ok(offeredModel?.connected, `C-1: hosted Pi model is unavailable after config push: ${JSON.stringify({ offeredModel, modelOverlays })}`)
    const api = hostedApi(stack, workspace)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
      const session = await hostedSession(stack, owner, workspace, { id: "pi", access: "native" }, model)
      await api.prompt(workspace.directory, session.id, "Reply with exactly HOSTEDPITURN", { model })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "hosted Pi settlement", timeoutMs: 60_000 })
      const messages = await api.messages(workspace.directory, session.id)
      if (frameType(settled) !== "session.idle" || !assistantText(messages).includes("HOSTEDPITURN")) {
        if (!target.secretNames.length && stack.model.requests.length === 0) {
          throw new Error(`C-1: hosted Pi sandbox has ${target.secretNames.length} brokered secrets, ${stack.model.requests.length} model requests, live ${frameType(settled)}, and stored assistant text ${JSON.stringify(assistantText(messages))}`)
        }
        throw new Error(`hosted Pi turn failed after credential delivery: secrets=${JSON.stringify(target.secretNames)} modelRequests=${stack.model.requests.length} settlement=${JSON.stringify(settled)}`)
      }
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"))
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.ok(stack.model.requests.some((request) => request.prompt.includes("HOSTEDPITURN")))
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H19.hostedpi refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
