import { asRecord } from "@claxedo/helpers/guards"
import { encodeApiError, PUBLIC_API_ERRORS } from "@claxedo/helpers/api-error"

export type HostTunnelFailureCode = "host_tunnel_timeout" | "host_tunnel_response_body_too_large" | "host_tunnel_unavailable"

export function hostTunnelFailure(code: HostTunnelFailureCode) {
  const detail = PUBLIC_API_ERRORS[code]
  return Object.assign(new Error(detail.message), { code, status: detail.status, retryable: code !== "host_tunnel_response_body_too_large" })
}

export function hostTunnelFailureResponse(error: unknown) {
  const code = asRecord(error)?.code
  const failure = hostTunnelFailure(code === "host_tunnel_timeout" || code === "host_tunnel_response_body_too_large" ? code : "host_tunnel_unavailable")
  return Response.json(encodeApiError(failure), { status: failure.status })
}
