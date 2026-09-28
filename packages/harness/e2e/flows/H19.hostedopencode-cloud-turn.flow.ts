import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { assistantText } from "../harness/api"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedApi, hostedOwner, hostedSession, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"

export async function run() {
  const stack = await startHostedStack("h19-hosted-opencode")
  try {
    const owner = await hostedOwner(stack)
    const stored = await hostedFetch(stack, "/auth/openai?harness=pi", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: { key: "hosted-owner-openai-key" } }),
    }, owner)
    assert.equal(stored.status, 200, `hosted OpenCode credential: ${await stored.text()}`)
    const workspace = await hostedWorkspace(stack, owner, "H19 hosted OpenCode")
    const target = JSON.parse(await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspace.id}.json`), "utf8")) as { secretNames: string[]; home: string }
    assert.ok(target.secretNames.includes("CLAXEDO_PROVIDER_OPENAI"), `C-11: hosted OpenCode sandbox has no OpenAI broker registration: ${JSON.stringify(target.secretNames)}`)
    const offered = await fetch(`${stack.relayUrl}/workspaces/${workspace.id}/api/wr/harness-config-options?nativeHarness=opencode`, {
      headers: { authorization: `Bearer ${workspace.runtimeAccessToken}` },
    })
    const offeredBody = await offered.json() as { options?: Array<{ id: string; selectOptions?: Array<{ id: string; connected?: boolean }> }> }
    assert.equal(offered.status, 200, `Hosted OpenCode model options returned ${offered.status}`)
    const offeredModel = offeredBody.options?.find((option) => option.id === "model")?.selectOptions?.find((choice) => choice.id === "openai/gpt-4.1")
    assert.ok(offeredModel, "C-11: OpenCode did not offer the supplied OpenAI credential")
    const api = hostedApi(stack, workspace)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const model = { providerId: "openai", modelId: "gpt-4.1" }
      const session = await hostedSession(stack, owner, workspace, { id: "opencode", access: "native" }, model)
      await api.prompt(workspace.directory, session.id, "Reply with exactly this one token: HOSTEDOPENCODETURN", { model })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "hosted OpenCode settlement", timeoutMs: 60_000 })
      const messages = await api.messages(workspace.directory, session.id)
      if (frameType(settled) !== "session.idle" || !assistantText(messages).includes("HOSTEDOPENCODETURN")) {
        if (!target.secretNames.length && stack.model.requests.length === 0) {
          throw new Error(`C-11: hosted OpenCode sandbox has ${target.secretNames.length} brokered secrets, ${stack.model.requests.length} model requests, live ${frameType(settled)}, and stored assistant text ${JSON.stringify(assistantText(messages))}`)
        }
        throw new Error(`hosted OpenCode turn failed after credential delivery: secrets=${JSON.stringify(target.secretNames)} modelRequests=${stack.model.requests.length} settlement=${JSON.stringify(settled)}`)
      }
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"))
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.ok(stack.model.requests.some((request) => request.prompt.includes("HOSTEDOPENCODETURN")))
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H19.hostedopencode refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
