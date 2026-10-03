import { expect, type Account, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import type { ReaderPage } from "../harness/session-reader"

export async function sharedReaderPage(signed: SignedStack, account: Account, workspaceId: string, sessionId: string, query: Readonly<Record<string, string>> = {}): Promise<ReaderPage> {
  const params = new URLSearchParams({ scope: "workspace", workspaceId, sessionId, limit: "2", settled: "all", seen: "all", ...query })
  const response = await hostedFetch(signed.hosted, `/api/control/session-list?${params}`, {}, account.person)
  expect(response.status, "the exact authorized reader inventory succeeds").toBe(200)
  return await response.json() as ReaderPage
}

export async function sharedProjectReceipt(signed: SignedStack, workspaceId: string) {
  const response = await hostedFetch(signed.hosted, "/api/workspace?host=machine", {}, signed.owner.person)
  expect(response.status).toBe(200)
  const { workspaces } = await response.json() as { workspaces: Array<Readonly<Record<string, unknown>>> }
  const row = workspaces.find((item) => item.workspace_id === workspaceId)
  expect(row, "the owner's canonical registration contains this workspace").toBeDefined()
  return Object.fromEntries(["workspace_id", "project_id", "project_name", "repo_key", "repo_name", "display_name", "remote_directory"].map((field) => [field, row![field]]))
}
