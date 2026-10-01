import { expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { LocalInstallationDocumentBroker } from "./backends/local/installation-broker"
import { mintDocumentRelayJobToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { privatePagesFixture } from "./private-pages-fixture"

test("relay-served reads and lists enforce the document share after job verification", async () => {
  const f = privatePagesFixture(); const page = await f.create()
  f.entries.get(page.id).org_id = "__local__"
  f.access.isOrgMember = async (userId) => f.members.has(userId)
  f.access.hasProjectAccess = async () => true
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const broker = LocalInstallationDocumentBroker({ backend: f.backend, installationToken: "installation", env })
  async function request(documentId: string, operation: "read" | "resolve", path: string) {
    const job = await mintDocumentRelayJobToken({ userId: "member", orgId: "__local__", projectId: "project", localWorkspaceId: "workspace", cloudWorkspaceId: "workspace", sessionId: "session", documentId, operations: [operation], jobExpiresAt: Math.floor(Date.now() / 1000) + 60 }, env)
    const headers = { authorization: "Bearer installation", "x-claxedo-document-broker": "1", "x-claxedo-document-capability": job.token, "x-claxedo-document-user": "member", "x-claxedo-local-workspace": "workspace", "x-claxedo-cloud-workspace": "workspace", "x-claxedo-document-session": "session", "x-claxedo-document-id": documentId, "x-claxedo-document-operation": operation }
    const query = "?org_id=__local__&project_id=project"
    expect((await broker.request(`http://local.test/jobs/activate${query}`, { method: "POST", headers })).status).toBe(200)
    return await broker.request(`http://local.test/${path}${query}`, { headers })
  }
  expect((await request(page.id, "read", page.id)).status).toBe(404)
  expect(await (await request("*", "resolve", "index")).json()).toEqual([])
  f.shares.push({ id: "share", document_id: page.id, org_id: "__local__", target: "person", target_id: "member", level: "view", created_by: "creator", revoked_at: null })
  expect((await request(page.id, "read", page.id)).status).toBe(200)
})
