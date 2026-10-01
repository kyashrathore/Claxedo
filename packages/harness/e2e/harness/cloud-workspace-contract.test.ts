import { expect, test } from "bun:test"
import { makeCloudWorkspace } from "../../../claxedo-app/e2e/harness/cloud"
import type { SignedStack } from "../../../claxedo-app/e2e/harness/signed-stack"

test("browser cloud creation sends the hosted contract and obtains the canonical project from D1", async () => {
  const requests: Array<{ method: string; url: string; body?: string }> = []
  const signed = {
    hosted: { workerUrl: "https://hosted.invalid", gitUrl: "http://127.0.0.1:42000/fixture.git" },
    owner: { transport: async (request: { method: string; url: string; body?: string }) => {
      requests.push(request)
      return { status: 200, body: JSON.stringify(request.method === "POST" ? { workspaceId: "ws_created", directory: "/workspace" } : {
        workspaces: [{ workspace_id: "ws_other", project_id: "prj_other" }, { workspace_id: "ws_created", project_id: "prj_canonical" }],
      }) }
    } },
  } as unknown as SignedStack
  const workspace = await makeCloudWorkspace(signed, "main")
  expect(JSON.parse(requests[0].body!)).toEqual({ workspaceName: "main", repoName: "main", repoUrl: signed.hosted.gitUrl })
  expect(requests[1]).toMatchObject({ method: "GET", url: `${signed.hosted.workerUrl}/api/workspace?host=cloud` })
  expect(workspace).toEqual({ id: "ws_created", projectId: "prj_canonical" })
})
