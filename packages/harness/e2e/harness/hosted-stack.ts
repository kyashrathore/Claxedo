import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hostedCertificate, startHostedControlPlane } from "./hosted-control-plane"
import { startHostedSandboxWorker } from "./hosted-sandbox-worker"
import { reservePort, releasePort } from "./ports"
import { startScriptedModelServer } from "./scripted-model-server"

export async function startHostedStack(label: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-hosted-${label}-`))
  const workerPort = await reservePort()
  const sandboxPort = await reservePort()
  const modelPort = await reservePort()
  const workerUrl = `https://127.0.0.1:${workerPort}`
  const sandboxOrigin = `https://127.0.0.1:${sandboxPort}`
  const credentials = await hostedCertificate(root)
  const model = await startScriptedModelServer({ port: modelPort, red: false })
  let sandbox: Awaited<ReturnType<typeof startHostedSandboxWorker>> | undefined
  let control: Awaited<ReturnType<typeof startHostedControlPlane>> | undefined
  try {
    sandbox = await startHostedSandboxWorker({
      root,
      port: sandboxPort,
      token: "hosted-sandbox-test-token",
      certificate: credentials.certificate,
      key: credentials.key,
      controlPlaneUrl: workerUrl,
      modelUrl: model.url,
    })
    control = await startHostedControlPlane({ root, port: workerPort, sandboxOrigin, credentials })
  } catch (error) {
    if (control) await control.close()
    if (sandbox) await sandbox.close()
    await model.close()
    for (const port of [workerPort, sandboxPort, modelPort]) releasePort(port)
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    root,
    workerUrl,
    sandboxOrigin,
    certificate: credentials.certificate,
    model,
    outboundAttempts: control.outboundAttempts,
    provisionOwnerClaim: control.provisionOwnerClaim,
    close: async () => {
      await control.close()
      await sandbox.close()
      await model.close()
      for (const port of [workerPort, sandboxPort, modelPort]) releasePort(port)
      if (process.env.CLAXEDO_E2E_KEEP_DATA !== "1") await fs.rm(root, { recursive: true, force: true })
    },
  }
}
