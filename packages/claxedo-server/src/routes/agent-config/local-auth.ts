import type {
  ClerkVerifier,
  ControlPlaneAuthConfig,
} from "../../control-plane/auth"
import { localOnlyProjectionResponse } from "../local-only-projection"

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
