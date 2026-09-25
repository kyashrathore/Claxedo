import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { hostedFetch, signInHostedPerson } from "../harness/hosted-auth"
import { hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"

export async function run() {
  const stack = await startHostedStack("h31-accounts")
  try {
    const owner = await hostedOwner(stack)
    const member = await signInHostedPerson(stack, "hosted-person-b")
    assert.notEqual(owner.id, member.id)
    const admitted = await hostedFetch(stack, "/api/control/user-deployed/identity-admissions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: member.id, role: "member" }),
    }, owner)
    assert.equal(admitted.status, 200, `hosted member admission: ${await admitted.text()}`)
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
    throw new Error("H31 per-person spending remains unasserted")
  } finally {
    console.log(`H31 refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
