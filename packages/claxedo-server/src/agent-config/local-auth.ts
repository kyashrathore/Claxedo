import type {
  ClerkVerifier,
  ControlPlaneAuthConfig,
} from "../platform/auth/auth"
import { localOnlyProjectionResponse } from "../platform/http/local-only-projection"

export async function localAgentConfigAllowed(input: {
  request: Request
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  label: string
}) {
  return localOnlyProjectionResponse(input.request, {
    authConfig: input.authConfig,
    verifier: input.verifier,
    label: input.label,
    missingBearerAsAuthError: true,
  })
}
