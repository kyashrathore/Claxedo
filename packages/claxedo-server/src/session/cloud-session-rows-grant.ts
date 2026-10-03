import type { CloudSessionRowsPublisher } from "@claxedo/server-core/platform/auth/cloud-session-rows"
import { RUNTIME_ACCESS_TOKEN_ALGORITHM } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { compactVerify } from "jose"
import { credentialFault, runtimeTokenVerificationKey } from "../platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass, type SandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"

export const CLOUD_SESSION_ROWS_AUDIENCE = "claxedo-cloud-session-rows"
export const CLOUD_SESSION_ROWS_OPERATION = "publish"

export class CloudSessionRowsConfigurationError extends Error {
  readonly code = "cloud_session_rows_misconfigured"
}

const fault = credentialFault("Cloud session rows", CloudSessionRowsConfigurationError)

export async function mintCloudSessionRowsGrant(
  publisher: CloudSessionRowsPublisher,
  env: Record<string, string | undefined>,
  options: { register: SandboxPassRegister; now?: () => number; ttlSeconds?: number; renewalOf?: string },
) {
  if (!Number.isSafeInteger(publisher.epoch) || publisher.epoch < 1) throw fault("a positive lease epoch")
  const { hostId, epoch, actorId, ...scope } = publisher
  return mintSandboxPass({
    audience: CLOUD_SESSION_ROWS_AUDIENCE,
    scope,
    operations: [CLOUD_SESSION_ROWS_OPERATION],
    extra: { host_id: hostId, lease_epoch: String(epoch), actor_id: actorId },
    renewable: true,
    ...options,
  }, env, fault)
}

export async function verifyCloudSessionRowsGrant(
  token: string,
  env: Record<string, string | undefined>,
  options: { passes: Pick<SandboxPassRegister, "revoked">; now?: () => number },
): Promise<CloudSessionRowsPublisher> {
  const pass = await verifySandboxPass(token, env, {
    audience: CLOUD_SESSION_ROWS_AUDIENCE, fault,
    revoked: (jti) => options.passes.revoked(jti),
    ...(options.now ? { now: options.now } : {}),
  })
  return publisherOf(pass)
}

/** Expiry is relaxed only for a retained renewal proof; publication still uses the ordinary expiry verifier. */
export async function verifyCloudSessionRowsRenewalGrant(
  token: string, env: Record<string, string | undefined>,
  options: { passes: Pick<SandboxPassRegister, "renewable">; now?: () => number },
) {
  const { key } = await runtimeTokenVerificationKey(env, fault)
  const verified = await compactVerify(token, key, { algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM] })
  const payload = asRecord(JSON.parse(new TextDecoder().decode(verified.payload)))
  if (!payload) throw new Error("Cloud producer renewal proof is invalid")
  const text = (name: string) => typeof payload[name] === "string" && payload[name] ? payload[name] : undefined
  const userId = text("user_id"), orgId = text("org_id"), workspaceId = text("workspace_id"), projectId = text("project_id"), jti = text("jti")
  const now = Math.floor((options.now?.() ?? Date.now()) / 1_000)
  if (payload.iss !== runtimeAccessTokenIssuer || payload.aud !== CLOUD_SESSION_ROWS_AUDIENCE
    || !userId || payload.sub !== userId || !orgId || !workspaceId || !projectId || !jti || payload.session_id !== undefined
    || typeof payload.iat !== "number" || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || (payload.iat) > now || (payload.exp) <= (payload.iat)
    || payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || (payload.nbf) > now)
    || !Array.isArray(payload.operations) || !payload.operations.every((item) => typeof item === "string")) {
    throw new Error("Cloud producer renewal proof is invalid")
  }
  const publisher = publisherOf({
    scope: { userId, orgId, workspaceId, projectId }, operations: payload.operations,
    extra: { host_id: payload.host_id, lease_epoch: payload.lease_epoch, actor_id: payload.actor_id },
  })
  if (!await options.passes.renewable(jti)) throw new Error("Cloud producer renewal proof is unknown or revoked")
  return { publisher, jti }
}

function publisherOf(pass: Pick<SandboxPass, "scope" | "operations" | "extra">): CloudSessionRowsPublisher {
  const { host_id: hostId, lease_epoch: epochText, actor_id: actorId } = pass.extra
  const epoch = typeof epochText === "string" && /^[1-9]\d*$/.test(epochText) ? Number(epochText) : NaN
  if (typeof hostId !== "string" || !hostId || typeof actorId !== "string" || !actorId
    || !Number.isSafeInteger(epoch) || !pass.scope.projectId || pass.scope.sessionId !== undefined
    || pass.operations.length !== 1 || pass.operations[0] !== CLOUD_SESSION_ROWS_OPERATION) {
    throw new Error("Cloud session rows producer scope is invalid")
  }
  return { ...pass.scope, projectId: pass.scope.projectId, hostId, epoch, actorId }
}
