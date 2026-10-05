import { expect, ownersColleague, SCRIPTED_ACP_HARNESS, sharing, test, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import type { HostedPerson } from "../../../harness/e2e/harness/hosted-auth"

const JSON_HEADERS = { "content-type": "application/json" }

function reads(signed: SignedStack, person: HostedPerson) {
  const call = (route: string, init: RequestInit = {}) => hostedFetch(signed.hosted, route, init, person)
  return {
    call,
    listed: async (query: string) => {
      const response = await call(`/api/control/session-list?${query}&settled=all`)
      expect(response.status, await response.clone().text()).toBe(200)
      return ((await response.json()) as { items: Array<{ sessionId: string }> }).items.map((row) => row.sessionId).toSorted()
    },
    open: async (workspaceId: string, sessionId: string) => (await call(`/api/control/sessions/${sessionId}/outline?workspaceId=${workspaceId}`)).status,
    connection: async (workspaceId: string, sessionId?: string) =>
      (await call(`/api/workspace/${workspaceId}/connection`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(sessionId ? { session: { sessionId } } : {}) })).status,
  }
}

test("58 isolation: a second account of the organization neither lists, opens nor connects to the owner's workspace sessions, and a share admits exactly the shared session", async ({ signed }) => {
  const colleague = await ownersColleague(signed, "Noor Colleague")
  const workspace = await signed.makeWorkspace("private", "Owner's private project")
  const shared = await signed.owner.api.createSession(workspace.directory, { title: "Shared one", harness: SCRIPTED_ACP_HARNESS })
  const hidden = await signed.owner.api.createSession(workspace.directory, { title: "Hidden one", harness: SCRIPTED_ACP_HARNESS })
  const owner = reads(signed, signed.owner.person)
  const theirs = reads(signed, colleague.person)
  const refused = [401, 403, 404]

  await expect.poll(() => owner.listed(`scope=workspace&workspaceId=${workspace.id}`), "the owner's rows reach the registry").toEqual([hidden.id, shared.id].toSorted())
  expect(await theirs.listed("scope=all")).toEqual([])
  expect(await theirs.listed(`scope=workspace&workspaceId=${workspace.id}`)).toEqual([])
  expect(refused).toContain(await theirs.open(workspace.id, shared.id))
  expect(refused).toContain(await theirs.open(workspace.id, hidden.id))
  expect(refused, "no workspace connection, so no events, sends or terminals").toContain(await theirs.connection(workspace.id))
  expect(refused).toContain(await theirs.connection(workspace.id, shared.id))
  expect(await owner.open(workspace.id, shared.id)).toBe(200)

  await sharing(signed, { workspaceId: workspace.id, sessionId: shared.id, userId: colleague.userId })("POST", "follow")
  expect(await theirs.listed("scope=all"), "exactly the shared session").toEqual([shared.id])
  expect(await theirs.open(workspace.id, shared.id)).toBe(200)
  expect(refused).toContain(await theirs.open(workspace.id, hidden.id))
  expect(refused, "a follow share grants no connection of the workspace").toContain(await theirs.connection(workspace.id))
  expect(refused).toContain(await theirs.connection(workspace.id, hidden.id))

  await sharing(signed, { workspaceId: workspace.id, sessionId: shared.id, userId: colleague.userId })("DELETE")
  expect(await theirs.listed("scope=all")).toEqual([])
  expect(refused).toContain(await theirs.open(workspace.id, shared.id))
})
