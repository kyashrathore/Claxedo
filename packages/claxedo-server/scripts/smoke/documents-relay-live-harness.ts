import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Hono } from "hono"
import { createWorkspaceRelayBun, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp, relayWorkspaceRuntimeExposure } from "../../../workspace-runtime/src/index"
import { LocalInstallationDocumentBroker } from "../../src/documents/local-installation-broker"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "../../src/documents/local-managed"
import { mintDocumentRelayJobToken } from "../../src/control-plane/runtime-access-token"
import { captureWorkspaceRuntimeInternalSecrets } from "../../../workspace-runtime/src/internal-secrets"
import type { DocumentsRouteBackend } from "../../src/routes/documents"
import type { DocumentIndexEntry } from "../../src/documents/index-store"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "documents-relay-live-"))
const runtimeKey = await generateKeyPair("EdDSA", { extractable: true })
const relayHostKey = await generateKeyPair("EdDSA", { extractable: true })
const installationToken = `installation_${crypto.randomUUID().replaceAll("-", "")}`
const managed = createLocalManagedDocumentWorkspace({ dataRoot: root })
const entry = {
  id: "document_live_relay",
  org_id: "__local__",
  project_id: "project_live_relay",
  display_name: "Relay Live Smoke",
  origin_kind: "managed",
  placement_kind: "local",
  placement_id: "local",
  managed_relative_path: managedDocumentRelativePath({
    projectId: "project_live_relay",
    documentId: "document_live_relay",
    slug: "Relay Live Smoke",
  }),
  repository_id: null,
  workspace_id: null,
  repository_relative_path: null,
  branch: null,
  status: "draft",
  session_id: null,
  archived_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_opened_at: null,
  last_known_file_version: null,
} satisfies DocumentIndexEntry
const handle = await managed.resolve({
  origin: "managed",
  placement: "local",
  projectId: entry.project_id,
  documentId: entry.id,
  relativePath: entry.managed_relative_path,
})
const created = await managed.create(
  {
    origin: "managed",
    placement: "local",
    projectId: entry.project_id,
    documentId: entry.id,
    relativePath: entry.managed_relative_path,
  },
  { markdown: "before cloud VM relay\n", actor: { type: "user", id: "relay-smoke" } },
)
const backend = {
  index: {
    list: async () => [entry],
    find: async (_orgId: string, documentId: string) => (documentId === entry.id ? entry : undefined),
    update: async () => entry,
  },
  workspace: managed,
} as unknown as DocumentsRouteBackend
const local = new Hono().route(
  "/internal/documents",
  LocalInstallationDocumentBroker({ backend, installationToken }),
)
const localServer = Bun.serve({ port: 0, fetch: local.fetch })

process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(runtimeKey.publicKey)
process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL = String(localServer.url).replace(/\/$/, "")
process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN = installationToken
const internalSecrets = captureWorkspaceRuntimeInternalSecrets()
delete process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN

const runtime = createWorkspaceRuntimeApp({
  exposure: relayWorkspaceRuntimeExposure({
    key: relayHostKey.publicKey,
    workspaceId: "local_ws",
    hostId: "host_live_relay",
  }),
  internalSecrets,
})
const runtimeServer = Bun.serve({ port: 0, fetch: runtime.app.fetch })
const relay = createWorkspaceRelayBun({
  runtimeAccessKey: runtimeKey.publicKey,
  relayHostSigningKey: relayHostKey.privateKey,
  relayHostAlgorithm: "EdDSA",
  isRuntimeAccessTokenActive: async () => ({ active: true }),
  resolveTarget: async () => ({
    workspaceId: "local_ws",
    hostId: "host_live_relay",
    baseUrl: String(runtimeServer.url).replace(/\/$/, ""),
    access: "cloud",
    backing: "cloud-vm",
  }),
})
const relayServer = Bun.serve({ port: 0, fetch: relay.fetch, websocket: relay.websocket })
const now = Date.now()
const runtimeAccessToken = await mintRuntimeAccessToken(
  {
    subject: "user_live_relay",
    orgId: "org_live_relay",
    workspaceId: "local_ws",
    hostId: "host_live_relay",
    role: "editor",
    ttlSeconds: 30 * 60,
    now,
  },
  runtimeKey.privateKey,
  "EdDSA",
)
const runtimePrivatePem = await exportPKCS8(runtimeKey.privateKey)
const runtimePublicPem = await exportSPKI(runtimeKey.publicKey)
const documentCapabilities = await Promise.all(
  (["read", "write", "write"] as const).map((operation) =>
    mintDocumentRelayJobToken(
      {
        userId: "user_live_relay",
        orgId: "org_live_relay",
        projectId: entry.project_id,
        localWorkspaceId: "local_ws",
        cloudWorkspaceId: "cloud_ws",
        sessionId: "session_live_relay",
        documentId: entry.id,
        operations: [operation],
        jobExpiresAt: Math.floor(now / 1_000) + 30 * 60,
      },
      {
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: runtimePrivatePem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: runtimePublicPem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      },
    ),
  ),
)

const liveConfig = {
  relayUrl: String(relayServer.url).replace(/\/$/, ""),
  runtimeAccessToken,
  readCapability: documentCapabilities[0].token,
  writeCapability: documentCapabilities[1].token,
  staleCapability: documentCapabilities[2].token,
  createdVersion: created.version,
  canonicalPath: handle.canonicalPath,
  endpoint: "/workspaces/local_ws/api/wr/local-documents/broker",
}
const configPath = path.join(root, "relay-live-config.json")
const configFile = await fs.open(configPath, "wx", 0o600)
await configFile.writeFile(JSON.stringify(liveConfig)).finally(() => configFile.close())
console.log(
  `DOCUMENTS_RELAY_LIVE ${JSON.stringify({
    relayUrl: liveConfig.relayUrl,
    canonicalPath: liveConfig.canonicalPath,
    configPath,
  })}`,
)

async function close() {
  await fs.unlink(configPath).catch(() => undefined)
  relayServer.stop(true)
  runtimeServer.stop(true)
  localServer.stop(true)
  await runtime.host.dispose()
  await fs.rm(root, { recursive: true, force: true })
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0))
  })
}

await new Promise(() => undefined)
