import assert from "node:assert/strict"
import { startHostedStack } from "../../../../../harness/e2e/harness/hosted-stack"
import { hostedOwner } from "../../../../../harness/e2e/harness/hosted-flow"
import { hostedFetch } from "../../../../../harness/e2e/harness/hosted-auth"
import { cloudWorkspaceSource, createCloudWorkspace } from "@/features/workspaces/data/workspace-create-api"
import { readArray, readString } from "@/lib/record"

async function run() {
  const stack = await startHostedStack("app-onboarding")
  const previous = Object.getOwnPropertyDescriptor(globalThis, "api")
  try {
    const owner = await hostedOwner(stack)
    const calls: string[] = []
    Object.defineProperty(globalThis, "api", { configurable: true, value: {
      account: {
        state: async () => ({ status: "signed", identity: { userId: owner.id } }),
        onState: () => () => undefined,
        signIn: async () => ({ status: "signed", identity: { userId: owner.id } }),
        signOut: async () => ({ status: "unsigned" }),
        run: async (operation: string, body: Record<string, unknown>) => {
          assert.equal(operation, "workspace.create")
          calls.push(operation)
          const result = await hostedFetch(stack, "/api/workspace/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }, process.env.CLAXEDO_APP_ONBOARDING_TEST_REFUSE_CREATE === "1" ? undefined : owner)
          if (!result.ok) throw new Error(`Workspace creation refused: ${result.status} ${await result.text()}`)
          return result.json()
        },
      },
    } })
    const created = await createCloudWorkspace({
      baseUrl: stack.workerUrl,
      projectName: "Onboarding project",
      ...cloudWorkspaceSource({ kind: "repository", repoUrl: stack.gitUrl }),
    })
    assert.ok(created.workspaceId)
    assert.deepEqual(calls, ["workspace.create"])
    const inventory = await hostedFetch(stack, "/api/workspace?host=provisioner", {}, owner)
    assert.equal(inventory.status, 200)
    const workspaces = readArray(await inventory.json(), "workspaces")
    assert.ok(workspaces?.some((row) => readString(row, "workspace_id") === created.workspaceId), "Created workspace missing from signed inventory")

    let connected = false
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(created.workspaceId)}/connection`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }, owner)
      if (response.ok) {
        connected = true
        break
      }
      assert.equal(response.status, 409)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.ok(connected, "Created workspace never connected")
    const unsigned = await hostedFetch(stack, "/api/workspace/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: stack.gitUrl }),
    })
    assert.equal(unsigned.status, 401)
  } finally {
    if (previous) Object.defineProperty(globalThis, "api", previous)
    else Reflect.deleteProperty(globalThis, "api")
    await stack.close()
  }
}

await run()
console.log("Signed workspace created, listed and connected; unsigned create refused")
