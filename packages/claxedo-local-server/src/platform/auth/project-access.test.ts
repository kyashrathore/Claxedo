import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { projectAccess } from "./project-access"

const signed: SignedControlPlaneAuth = {
  mode: "signed",
  user: { subject: "usr_1", tokenIdentifier: "tok_1", issuer: "https://issuer.test" },
}

function authorityAnswering(ok: boolean) {
  const authorizeProject = vi.fn(async () => (ok ? { ok: true, role: "editor", orgId: "org_1" } : { ok: false }))
  return { authorizeProject, services: { authorizeProject } as unknown as WorkspaceAuthority }
}

describe("project access", () => {
  test("no signed caller is the local product: every project, and workspace creation allowed", async () => {
    const access = projectAccess(undefined, undefined)
    expect(access.local).toBe(true)
    await expect(access.allowed("prj_anything", "write")).resolves.toBe(true)
  })

  test("a signed caller is decided by the authority, which is asked for the exact project and action", async () => {
    const granting = authorityAnswering(true)
    const access = projectAccess(signed, { authority: granting.services })
    expect(access.local).toBe(false)
    await expect(access.allowed("prj_1", "write")).resolves.toBe(true)
    expect(granting.authorizeProject).toHaveBeenCalledWith(signed, { projectId: "prj_1", action: "write" })

    const refusing = authorityAnswering(false)
    await expect(projectAccess(signed, { authority: refusing.services }).allowed("prj_1", "read")).resolves.toBe(false)
    expect(refusing.authorizeProject).toHaveBeenCalledWith(signed, { projectId: "prj_1", action: "read" })
  })

  test("a signed caller with no authority configured is refused, never answered locally", () => {
    for (const services of [undefined, {}, { authority: undefined }]) {
      const refusal = (() => {
        try {
          projectAccess(signed, services)
          return undefined
        } catch (error) {
          return error
        }
      })()
      expect(refusal).toBeInstanceOf(ControlPlaneAuthError)
      expect(refusal).toMatchObject({ status: 503, code: "workspace_authority_unavailable" })
    }
  })
})
