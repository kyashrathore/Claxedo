import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hostedCertificate, startHostedControlPlane } from "./hosted-control-plane"
import { startHostedSandboxWorkerProcess as startHostedSandboxWorker } from "./hosted-sandbox-worker-process"
import { startHostedGitServer } from "./hosted-git-server"
import { startHostedRelay } from "./hosted-relay"
import { reservePort, releasePort } from "./ports"
import { startScriptedModelServer } from "./scripted-model-server"

export type HostedStackOptions = { apiOrigin?: string; appOrigin?: string; emailPassword?: boolean; relayPort?: number }

export async function startHostedStack(label: string, options: HostedStackOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-hosted-${label}-`))
  const workerPort = await reservePort()
  const sandboxPort = await reservePort()
  const modelPort = await reservePort()
  const gitPort = await reservePort()
  const relayPort = options.relayPort ?? await reservePort()
  const leased = [workerPort, sandboxPort, modelPort, gitPort, ...(options.relayPort === undefined ? [relayPort] : [])]
  const workerOrigin = `https://127.0.0.1:${workerPort}`
  const workerUrl = options.apiOrigin ?? workerOrigin
  const sandboxOrigin = `https://127.0.0.1:${sandboxPort}`
  const relayUrl = `http://127.0.0.1:${relayPort}`
  const credentials = await hostedCertificate(root)
  const model = await startScriptedModelServer({ port: modelPort, red: false })
  const git = await startHostedGitServer(root, gitPort)
  let sandbox: Awaited<ReturnType<typeof startHostedSandboxWorker>> | undefined
  let control: Awaited<ReturnType<typeof startHostedControlPlane>> | undefined
  let relay: Awaited<ReturnType<typeof startHostedRelay>> | undefined
  try {
    sandbox = await startHostedSandboxWorker({
      root,
      port: sandboxPort,
      token: "hosted-sandbox-test-token",
      certificate: credentials.certificate,
      key: credentials.key,
      controlPlaneUrl: workerUrl,
      modelUrl: model.url,
      gitUrl: git.url,
      relayUrl,
    })
    control = await startHostedControlPlane({ root, port: workerPort, sandboxOrigin, gitUrl: git.url, relayUrl, credentials,
      apiOrigin: workerUrl, appOrigin: options.appOrigin ?? workerUrl, emailPassword: options.emailPassword })
    relay = await startHostedRelay({ root, port: relayPort, controlPlaneUrl: workerUrl, certificate: credentials.certificate, allowedOrigins: [options.appOrigin ?? workerUrl],
      modelUrl: model.url })
  } catch (error) {
    if (relay) await relay.close()
    if (control) await control.close()
    if (sandbox) await sandbox.close()
    await model.close()
    await git.close()
    for (const port of leased) releasePort(port)
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    root,
    workerUrl,
    workerOrigin,
    credentials,
    sandboxOrigin,
    certificate: credentials.certificate,
    model,
    gitUrl: git.url,
    relayUrl,
    outboundAttempts: control.outboundAttempts,
    telemetryEvents: control.telemetryEvents,
    provisionOwnerClaim: control.provisionOwnerClaim,
    recordedEmailActionUrl: control.recordedEmailActionUrl,
    close: async () => {
      await relay.close()
      await control.close()
      await sandbox.close()
      await model.close()
      await git.close()
      for (const port of leased) releasePort(port)
      if (process.env.CLAXEDO_E2E_KEEP_DATA !== "1") await fs.rm(root, { recursive: true, force: true })
    },
  }
}
