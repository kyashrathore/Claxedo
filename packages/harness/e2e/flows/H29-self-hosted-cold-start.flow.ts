import { createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"

export async function run() {
  const stack = await startStack({ label: "h29-self-hosted-cold", cloud: true, coldStartWithoutKeys: true })
  try {
    const workspace = await createCloudWorkspace(stack, "h29-cold")
    const connection = await waitCloudConnection(stack, workspace.id)
    const body = JSON.parse(connection.body) as { status?: string; runtimeAccessToken?: string }
    if (connection.status !== 200 || !body.runtimeAccessToken) {
      const log = stack.daemon.log().split("\n").filter((line) => /signer|config push|verification|sandbox|runtime/i.test(line)).slice(-10).join("\n")
      throw new Error(`C-5: self-hosted cold start did not create signing keys and deliver the settings snapshot: ${connection.status} ${body.status ?? "error"}\n${log}`)
    }
  } finally {
    await stack.close()
  }
}
