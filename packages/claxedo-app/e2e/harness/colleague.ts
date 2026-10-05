import { hostedFetch, inviteHostedPerson } from "../../../harness/e2e/harness/hosted-auth"
import { expect } from "./fixtures"
import type { SignedStack } from "./signed-stack"

export async function ownersColleague(signed: SignedStack, name: string) {
  const colleague = await signed.signUp(name)
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  expect(orgs.status).toBe(200)
  const [{ org_id: orgId }] = await orgs.json() as Array<{ org_id: string }>
  const token = await inviteHostedPerson(signed.hosted, signed.owner.person, colleague.person, orgId)
  const accepted = await hostedFetch(signed.hosted, "/api/control/invitations/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }, colleague.person)
  expect(accepted.status).toBe(200)
  const { user_id: userId } = await accepted.json() as { user_id: string }
  return { ...colleague, userId }
}

export function sharing(signed: SignedStack, input: { workspaceId: string; sessionId: string; userId: string }) {
  return async (method: "POST" | "DELETE", level?: "follow" | "send") => {
    const response = await hostedFetch(signed.hosted, `/api/control/sessions/${input.sessionId}/shares`, {
      method, headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: input.workspaceId, grantedToUserId: input.userId, level }),
    }, signed.owner.person)
    expect(response.status, await response.text()).toBe(200)
  }
}
