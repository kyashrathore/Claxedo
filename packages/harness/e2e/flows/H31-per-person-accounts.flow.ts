import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { assistantText } from "../harness/api"
import { hostedFetch, inviteHostedPerson, signInHostedPerson } from "../harness/hosted-auth"
import { hostedPiSession } from "../harness/hosted-cloud"
import { hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startHostedStack("h31-accounts")
  try {
    const owner = await hostedOwner(stack)
    const member = await signInHostedPerson(stack, "hosted-person-b")
    assert.notEqual(owner.id, member.id)
    const invitationToken = await inviteHostedPerson(stack, owner, member, "hosted-e2e-organization")
    const accepted = await hostedFetch(stack, "/api/control/invitations/accept", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invitationToken }),
    }, member)
    assert.equal(accepted.status, 200, `hosted invitation acceptance: ${await accepted.text()}`)
    for (const [person, key] of [[owner, "hosted-owner-key"], [member, "hosted-member-key"]] as const) {
      const stored = await hostedFetch(stack, "/api/claxedo/credentials", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "managed", label: "OpenAI", secret: key }),
    }, person)
      assert.equal(stored.status, 200, `hosted account storage for ${person.id}: ${await stored.text()}`)
    }
    const workspace = await hostedWorkspace(stack, owner, "H31 owner session")
    const target = await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspace.id}.json`), "utf8")
    const secretNames = (JSON.parse(target) as { secretNames: string[] }).secretNames
    if (!secretNames.length) throw new Error(`C-1: hosted delivered no brokered account to the owner's sandbox; stored owner and member accounts cannot be spent`)
    const session = await hostedPiSession(stack, owner, workspace, { providerId: "pi", modelId: "openai/gpt-4.1" })
    await session.create()
    const stream = await session.events()
    try {
      await session.prompt("Reply with exactly this one token: H31OWNER")
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.sessionId &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H31 owner settlement", timeoutMs: 60_000 })
      const spent = stack.model.requests.find((request) => request.prompt.includes("H31OWNER"))
      if (frameType(settled) !== "session.idle" || !spent) {
        throw new Error(`C-1: hosted owner Pi turn did not spend the owner's account: ${JSON.stringify({ settlement: frameType(settled), requests: stack.model.requests.length, assistant: assistantText(await session.messages()) })}`)
      }
      assert.equal(spent.authorization, "Bearer hosted-owner-key",
        `C-12: owner turn spent another person's OpenAI account: ${JSON.stringify({ memberKeySpent: spent.authorization === "Bearer hosted-member-key", owner: owner.id, member: member.id })}`)
      await waitForTitle(stream, session.sessionId)
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H31 refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
