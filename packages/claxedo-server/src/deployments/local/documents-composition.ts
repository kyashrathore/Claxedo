import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import type { ControlPlaneServices } from "../../authority/services"
import { DocumentsRoutes } from "../../documents/routes/index"
import { createLocalDocumentsBackend } from "../../documents/backends/local/backend"
import { setDocumentChangedSink } from "../../documents/backend"
import { LocalInstallationDocumentBroker } from "../../documents/backends/local/installation-broker"
import { claxedoBus } from "../../platform/runtime/lib/bus"
import { dataDir } from "../../platform/runtime/lib/paths"
import { reportError } from "../../platform/telemetry/errors/report"
import { resolveWorkspace } from "../../workspace/store"
import { sessionMeta } from "../../session/meta"

const execFileAsync = promisify(execFile)

export function localDocumentsBackend() {
  return createLocalDocumentsBackend({
    resolveWorkspace,
    sessionMeta,
    dataDir,
    reportError,
    runGit: async (args, directory, options) =>
      (
        await execFileAsync("git", [...args], {
          cwd: directory,
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
          ...(options?.maxBufferBytes ? { maxBuffer: options.maxBufferBytes } : {}),
        })
      ).stdout.trim(),
  })
}

export function createLocalDocumentsApp(input: {
  services: ControlPlaneServices
  installationToken?: string
  env: Record<string, string | undefined>
}) {
  const backend = localDocumentsBackend()
  const auth = {
    authConfig: input.services.auth.config,
    ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
  }
  setDocumentChangedSink((event) => claxedoBus.publish(event))
  return new Hono().route("/documents", DocumentsRoutes({ backend, services: input.services, ...auth })).route(
    "/internal/documents",
    LocalInstallationDocumentBroker({
      backend,
      ...(input.installationToken ? { installationToken: input.installationToken } : {}),
      env: input.env,
    }),
  )
}
