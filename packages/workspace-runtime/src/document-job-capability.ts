import { importSPKI, jwtVerify } from "jose"

export type DocumentJobExpected = Readonly<{
  userId: string
  orgId: string
  projectId: string
  localWorkspaceId: string
  cloudWorkspaceId: string
  sessionId: string
  documentId: string
  operation: "hydrate" | "read" | "write" | "resolve"
}>

export async function verifyDocumentJobCapability(token: string, expected: DocumentJobExpected) {
  const pem = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n").trim()
  if (!pem) throw new Error("Document job verifier is unavailable")
  const alg = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM === "ES256" ||
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM === "RS256"
    ? process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM
    : "EdDSA"
  const result = await jwtVerify(token, await importSPKI(pem, alg), {
    issuer: "claxedo-control-plane",
    audience: "document-relay-job",
  })
  const value = result.payload as Record<string, unknown>
  const operations = Array.isArray(value.operations) ? value.operations : []
  const fields = {
    user_id: expected.userId,
    org_id: expected.orgId,
    project_id: expected.projectId,
    local_workspace_id: expected.localWorkspaceId,
    cloud_workspace_id: expected.cloudWorkspaceId,
    session_id: expected.sessionId,
    document_id: expected.documentId,
  }
  if (!operations.includes(expected.operation) || Object.entries(fields).some(([key, expected]) => value[key] !== expected) ||
    typeof value.job_exp !== "number" || value.job_exp <= Math.floor(Date.now() / 1000) || typeof value.jti !== "string") {
    throw new Error("Document job capability scope is invalid")
  }
  return { jti: value.jti, jobExpiresAt: value.job_exp }
}
