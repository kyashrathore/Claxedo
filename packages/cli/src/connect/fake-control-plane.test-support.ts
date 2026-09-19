/**
 * The control plane a `claxedo connect` host and the `claxedo host` owner
 * commands talk to, as these tests see it: host-connector's strict fake owns
 * the machine routes and every refusal they issue; this file composes the
 * owner routes — the account-side twins the CLI drives with a bearer — over
 * the state that fake exposes, in the real routes' response shapes.
 */

import { createFakeControlPlane, FakeRefusal, type FakeOwnerRequest } from "@claxedo/host-connector/test-support"
import { asArray, asRecordOrEmpty, asString, isString } from "@claxedo/helpers/guards"
import { requestJson } from "../http"

export { decodeFakeTunnelToken } from "@claxedo/host-connector/test-support"

export const OWNER_TOKEN = "owner-bearer"

const stringsOf = (value: unknown) => asArray(value).filter(isString)

export function createFakeConnectControlPlane(options: { now?: () => number; url?: string; relayUrl?: string } = {}) {
  const cp = createFakeControlPlane({ ...options, owner: (request) => owner(request) })

  /** The list route's row (`HostEnrollmentListRow`): the owner's declarations for the machine, and what it acks at its CURRENT generation. */
  const machines = () =>
    [...cp.enrollments.values()]
      .filter((enrollment) => enrollment.revoked_at === undefined)
      .map((enrollment) => ({
        enrollment_id: enrollment.enrollment_id,
        display_name: enrollment.display_name,
        host_id: enrollment.host_id,
        public_key_fingerprint: enrollment.fingerprint,
        key_version: enrollment.key_version,
        enrolled_via: "invitation",
        last_seen_at: enrollment.last_seen_at,
        expires_at: enrollment.expires_at,
        serving_generation: enrollment.serving_generation,
        ...(enrollment.paused_at !== undefined ? { paused_at: enrollment.paused_at } : {}),
        assignments: [...cp.assignments.values()]
          .filter((assignment) => assignment.enrollment_id === enrollment.enrollment_id)
          .map((assignment) => ({
            workspace_id: assignment.workspace_id,
            remote_directory: assignment.remote_directory,
            ...(assignment.display_name ? { display_name: assignment.display_name } : {}),
            revision: assignment.revision,
          })),
        acked: [...cp.readiness]
          .filter(([, ready]) => ready.enrollment_id === enrollment.enrollment_id && ready.generation === enrollment.serving_generation)
          .map(([workspaceId, ready]) => ({ workspaceId, revision: ready.revision })),
        scope: enrollment.scope,
      }))

  const owner = async ({ method, url, headers, body }: FakeOwnerRequest) => {
    if (headers.get("authorization") !== `Bearer ${OWNER_TOKEN}`) throw new FakeRefusal(401, "unauthorized")
    const pathname = url.pathname
    if (method === "POST" && pathname === "/api/claxedo/host/invitations") {
      const scope = asRecordOrEmpty(body.scope)
      const minted = await cp.createInvitation({
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        scope: { allowed_roots: stringsOf(scope.allowed_roots), visibility: scope.visibility === "org" ? "org" : "owner" },
        ...(typeof body.expiresInMs === "number" ? { expiresInMs: body.expiresInMs } : {}),
      })
      return { invitation_id: minted.invitationId, token: minted.token, expires_at: minted.expiresAt }
    }
    if (method === "GET" && pathname === "/api/claxedo/host/enrollments") return { active: null, machines: machines() }
    const scopeMatch = /^\/api\/claxedo\/host\/enrollments\/([^/]+)\/scope$/.exec(pathname)
    if (method === "PATCH" && scopeMatch) {
      return cp.setScope(decodeURIComponent(scopeMatch[1]), {
        allowed_roots: stringsOf(body.allowed_roots),
        visibility: body.visibility === "org" ? "org" : "owner",
      })
    }
    const providerConfigMatch = /^\/api\/claxedo\/host\/enrollments\/([^/]+)\/provider-config$/.exec(pathname)
    if (method === "POST" && providerConfigMatch) {
      const enrollmentId = decodeURIComponent(providerConfigMatch[1])
      const providers = asRecordOrEmpty(body.providers)
      const sealed = Object.keys(providers).length > 0
      // The route's `serializeHostProviderConfig` shape; the host opens it
      // with `parseHostProviderConfig`, so a drift here fails the lifecycle test.
      const revision = await cp.pushProviderConfig(enrollmentId, sealed ? JSON.stringify({ version: 1, providers }) : null)
      return { enrollment_id: enrollmentId, revision, sealed }
    }
    const deviceMatch = /^\/api\/claxedo\/remote-access\/devices\/([^/]+)$/.exec(pathname)
    if (method === "DELETE" && deviceMatch) {
      const enrollment = cp.enrollmentByHostId(decodeURIComponent(deviceMatch[1]))
      if (!enrollment) throw new FakeRefusal(404, "host_enrollment_not_found")
      cp.revoke(enrollment.enrollment_id)
      return { revoked: true }
    }
    const assignMatch = /^\/api\/workspace\/([^/]+)\/host-assignment$/.exec(pathname)
    if (assignMatch && method === "POST") {
      const workspaceId = decodeURIComponent(assignMatch[1])
      const hostId = asString(body.hostId) ?? ""
      const revision = cp.assign({
        hostId,
        workspaceId,
        remoteDirectory: asString(body.remoteDirectory) ?? "",
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      })
      return { assigned: true, workspace_id: workspaceId, host_id: hostId, revision }
    }
    if (assignMatch && method === "DELETE") {
      cp.unassign(decodeURIComponent(assignMatch[1]))
      return { unassigned: true }
    }
    throw new FakeRefusal(404, "not_found")
  }

  /** `requestJson` bound to this fake instead of the global fetch, for the owner commands. */
  const request: typeof requestJson = (input) => requestJson({ ...input, fetch: cp.fetch })

  return { ...cp, request }
}

export type FakeControlPlane = ReturnType<typeof createFakeConnectControlPlane>
