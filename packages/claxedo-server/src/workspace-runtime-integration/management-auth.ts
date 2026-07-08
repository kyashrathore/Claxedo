import {
  WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER,
  type WorkspaceRuntimeManagementAuth,
} from "@claxedo/workspace-runtime/config"
import {
  SupervisorBackplaneAuthError,
  verifySupervisorBackplaneToken,
  type SupervisorBackplaneVerifierKey,
} from "../control-plane/runtime-access-token"

export function createClaxedoManagementAuth(input: {
  key: SupervisorBackplaneVerifierKey
}): WorkspaceRuntimeManagementAuth {
  return {
    async authorize(request) {
      const token = request.request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER)?.trim()
      if (!token) {
        return {
          ok: false,
          status: 401,
          code: "claxedo_management_token_required",
          message: "Claxedo management token is required",
        }
      }

      try {
        const claims = await verifySupervisorBackplaneToken(token, input.key, {
          workspaceId: request.target.workspaceId,
          hostId: request.target.hostId,
        })
        if (claims.action !== request.action && !claims.scopes.includes(request.action)) {
          return {
            ok: false,
            status: 403,
            code: "claxedo_management_action_denied",
            message: "Claxedo management token does not grant this action",
          }
        }
        return {
          ok: true,
          subject: claims.sub,
          scopes: claims.scopes.includes(request.action) ? claims.scopes : [...claims.scopes, request.action],
        }
      } catch (err) {
        return {
          ok: false,
          status: 401,
          code: err instanceof SupervisorBackplaneAuthError ? err.code : "invalid_claxedo_management_token",
          message: "Claxedo management token is invalid",
        }
      }
    },
  }
}
