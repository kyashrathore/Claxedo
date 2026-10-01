import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { assistantText } from "../harness/api"
import { hostedFetch, signInHostedPerson } from "../harness/hosted-auth"
import { hostedApi, hostedOwner, hostedSession, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startHostedStack("h31-accounts")
  try {
    const owner = await hostedOwner(stack)
    const member = await signInHostedPerson(stack, "hosted-person-b")
    assert.notEqual(owner.id, member.id)
    const invitationToken = await stack.inviteMember(owner.id, member.id)
    const accepted = await hostedFetch(stack, `/api/control/invitations/${invitationToken}/accept`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, member)
    assert.equal(accepted.status, 200, `hosted invitation acceptance: ${await accepted.text()}`)
    for (const [person, key] of [[owner, "hosted-owner-key"], [member, "hosted-member-key"]] as const) {
      const stored = await hostedFetch(stack, "/auth/openai?harness=pi", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth: { key } }),
      }, person)
      assert.equal(stored.status, 200, `hosted account storage for ${person.id}: ${await stored.text()}`)
    }
    const workspace = await hostedWorkspace(stack, owner, "H31 owner session")
    const target = await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspace.id}.json`), "utf8")
    const secretNames = (JSON.parse(target) as { secretNames: string[] }).secretNames
    if (!secretNames.length) throw new Error(`C-1: hosted delivered no brokered account to the owner's sandbox; stored owner and member accounts cannot be spent`)
    const api = hostedApi(stack, workspace)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const session = await hostedSession(stack, owner, workspace, { id: "pi", access: "native" }, model)
      await api.prompt(workspace.directory, session.id, "Reply with exactly this one token: H31OWNER", { model, title: true })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H31 owner settlement", timeoutMs: 60_000 })
      const spent = stack.model.requests.find((request) => request.prompt.includes("H31OWNER"))
      if (frameType(settled) !== "session.idle" || !spent) {
        throw new Error(`C-1: hosted owner Pi turn did not spend a brokered account: ${JSON.stringify({ settlement: frameType(settled), requests: stack.model.requests.length, assistant: assistantText(await api.messages(workspace.directory, session.id)) })}`)
      }
      assert.equal(spent.authorization, "Bearer hosted-owner-key",
        `C-12: owner turn spent another person's OpenAI account: ${JSON.stringify({ memberKeySpent: spent.authorization === "Bearer hosted-member-key", owner: owner.id, member: member.id })}`)
      await waitForTitle(stream, session.id)
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H31 refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
