import type { Hono } from "hono"
import { expect } from "vitest"
import { BETTER_AUTH_NATIVE_SCOPES } from "../platform/auth/better-auth-d1-foundation"
import { BETTER_AUTH_CLI_CLIENT_ID } from "../platform/auth/better-auth-native-clients"

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }
export type DeviceRequestView = { user_code: string; status: string; client_id?: string; scope?: string; transaction?: string }

/**
 * The RFC 8628 routes `claxedo login` and the `/device` page call, against one
 * composed app under its public origin.
 */
export function deviceGrant(app: Hono, origin: string) {
  const request = (pathname: string, init?: RequestInit) => app.request(new URL(pathname, origin).toString(), init)
  const resource = `${origin}/control-plane`
  return {
    resource,
    request,
    async requestCode(): Promise<DeviceCode> {
      const response = await request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: BETTER_AUTH_CLI_CLIENT_ID, scope: BETTER_AUTH_NATIVE_SCOPES.join(" "), resource }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as DeviceCode
    },
    view(userCode: string, headers: Record<string, string>) {
      return request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { headers })
    },
    async viewed(userCode: string, headers: Record<string, string>): Promise<DeviceRequestView> {
      const response = await this.view(userCode, headers)
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as DeviceRequestView
    },
    decide(kind: "approve" | "deny", body: Record<string, unknown>, headers: Record<string, string>) {
      return request(`/api/auth/device/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    },
    exchange(deviceCode: string) {
      return request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: BETTER_AUTH_CLI_CLIENT_ID, resource }).toString(),
      })
    },
  }
}
