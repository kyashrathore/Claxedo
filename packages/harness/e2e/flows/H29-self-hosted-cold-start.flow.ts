import { createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"

export async function run() {
  const stack = await startStack({ label: "h29-self-hosted-cold", cloud: true, coldStartWithoutKeys: true })
  try {
    const workspace = await createCloudWorkspace(stack, "h29-cold")
    const connection = await waitCloudConnection(stack, workspace.id)
    const body = JSON.parse(connection.body) as { status?: string; runtimeAccessToken?: string }
    if (connection.status !== 200 || !body.runtimeAccessToken) {
      const log = stack.daemon.log().split("\n").slice(-30).join("\n")
      throw new Error(`C-5: self-hosted cold start did not create signing keys and deliver the settings snapshot: ${connection.status} ${body.status ?? "error"}\n${log}`)
    }
    const health = await fetch(`${stack.url}/workspaces/${encodeURIComponent(workspace.id)}/api/wr/health`, {
      headers: { authorization: `Bearer ${stack.daemon.cloudToken}` },
    })
    const runtime = await health.json() as { ok?: boolean; status?: string; harness?: { kind?: string; harnessId?: string } }
    if (health.status !== 200 || !runtime.ok || runtime.harness?.harnessId !== "pi") {
      throw new Error(`C-5: signed snapshot did not make the sandbox ready with its configured harness: ${health.status} ${JSON.stringify(runtime)}`)
    }
  } finally {
    await stack.close()
  }
}
