import { readString } from "@/lib/record"
import { authResponseBody, betterAuthApiError } from "./better-auth-error"
import { apiOrigin } from "./origins"

export type DeviceAuthorizationRequest = {
  userCode: string
  status: "pending" | "approved" | "denied"
  clientId?: string
  scopes: readonly string[]
  transaction?: string
}

export const DEVICE_CODE_MISSING = "This link is missing its device code. Re-run the command and open the URL it prints."

function grantStatus(value: unknown): DeviceAuthorizationRequest["status"] {
  const status = readString(value, "status")
  if (status === "approved" || status === "denied") return status
  return "pending"
}

export async function readDeviceAuthorization(userCode: string): Promise<DeviceAuthorizationRequest> {
  const url = new URL("/api/auth/device", apiOrigin())
  url.searchParams.set("user_code", userCode)
  const response = await fetch(url.toString(), { credentials: "include", headers: { accept: "application/json" } })
  const body = await authResponseBody(response)
  if (!response.ok) throw betterAuthApiError(body, response.status, "Device authorization failed")
  const clientId = readString(body, "client_id")
  const transaction = readString(body, "transaction")
  return {
    userCode,
    status: grantStatus(body),
    ...(clientId ? { clientId } : {}),
    ...(transaction ? { transaction } : {}),
    scopes: (readString(body, "scope") ?? "").split(/\s+/).filter(Boolean),
  }
}

export async function submitDeviceDecision(input: { request: DeviceAuthorizationRequest; approve: boolean }): Promise<void> {
  const response = await fetch(new URL(`/api/auth/device/${input.approve ? "approve" : "deny"}`, apiOrigin()).toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: input.request.userCode, transaction: input.request.transaction }),
  })
  if (!response.ok) {
    throw betterAuthApiError(await authResponseBody(response), response.status, "Device authorization failed")
  }
}
