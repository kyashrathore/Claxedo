import { spawn } from "node:child_process"
import { config } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { cliAuthBinding, type CliAuthBinding, type FetchLike } from "./auth-descriptor"
import { OAuthError, tokenRequest, type TokenSet } from "./oauth"
import { writeCredentials, type Credentials } from "./token-store"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"

/**
 * `claxedo login`: the RFC 8628 device grant against the control plane's
 * Better Auth, for the `claxedo-cli` client its auth descriptor names.
 *
 * `POST {issuer}/device/code` → the user approves the code at the
 * `verification_uri` (the web app's `/device` page) → the CLI polls
 * `POST {issuer}/oauth2/token` with the device-code grant until it is
 * approved, denied or expired. The token it receives is the same opaque
 * access token the desktop holds, spent on every signed route as a bearer.
 */

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

type DeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalMs: number
  expiresAt: number
}

function deviceCode(input: unknown, now: number): DeviceCode {
  const row = object(input)
  const code = trimToUndefined(row.device_code)
  const userCode = trimToUndefined(row.user_code)
  const verificationUri = trimToUndefined(row.verification_uri)
  if (!code || !userCode || !verificationUri) {
    throw new Error("Device-code response is missing device_code, user_code, or verification_uri")
  }
  const complete = trimToUndefined(row.verification_uri_complete)
  return {
    deviceCode: code,
    userCode,
    verificationUri,
    ...(complete ? { verificationUriComplete: complete } : {}),
    intervalMs: Math.max(1, asFiniteNumber(row.interval) ?? 5) * 1000,
    expiresAt: now + Math.max(60, asFiniteNumber(row.expires_in) ?? 600) * 1000,
  }
}

function openBrowser(target: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}

export type LoginDeps = {
  controlPlaneUrl: string
  fetch?: FetchLike
  openBrowser: (target: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
  writeCredentials: (credentials: Credentials) => Promise<void>
}

export function defaultLoginDeps(): LoginDeps {
  return {
    controlPlaneUrl: config().controlPlaneUrl,
    openBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    writeCredentials,
  }
}

async function requestDeviceCode(binding: CliAuthBinding, deps: LoginDeps): Promise<DeviceCode> {
  return deviceCode(
    await requestJson({
      url: binding.deviceCodeUrl,
      method: "POST",
      body: { client_id: binding.cli.clientId, scope: binding.cli.scopes.join(" "), resource: binding.cli.resource },
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    deps.now(),
  )
}

async function pollForTokens(binding: CliAuthBinding, device: DeviceCode, deps: LoginDeps): Promise<TokenSet> {
  let intervalMs = device.intervalMs
  while (deps.now() < device.expiresAt) {
    await deps.sleep(intervalMs)
    try {
      return await tokenRequest({
        url: binding.tokenUrl,
        params: {
          grant_type: DEVICE_CODE_GRANT,
          device_code: device.deviceCode,
          client_id: binding.cli.clientId,
          resource: binding.cli.resource,
        },
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error
      if (error.error === "authorization_pending") continue
      if (error.error === "slow_down") {
        intervalMs += 5_000
        continue
      }
      if (error.error === "access_denied") throw new Error("Device login was denied in the browser.", { cause: error })
      if (error.error === "expired_token") break
      throw error
    }
  }
  throw new Error("Device login expired. Run `claxedo login` again.")
}

/** Who the token belongs to, for the sign-in line and `whoami`; the credential is already valid without it. */
async function identity(binding: CliAuthBinding, accessToken: string, deps: LoginDeps): Promise<string | undefined> {
  const info = object(
    await requestJson({ url: binding.userInfoUrl, token: accessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).catch(() => undefined),
  )
  return trimToUndefined(info.email) ?? trimToUndefined(info.name) ?? trimToUndefined(info.sub)
}

export async function login(deps: LoginDeps = defaultLoginDeps()) {
  const binding = await cliAuthBinding(deps.controlPlaneUrl, deps)
  const device = await requestDeviceCode(binding, deps)
  const browserUrl = device.verificationUriComplete ?? device.verificationUri
  deps.openBrowser(browserUrl)
  deps.log(`Open ${browserUrl}`)
  deps.log(`Enter code: ${device.userCode}`)

  const tokens = await pollForTokens(binding, device, deps)
  const who = await identity(binding, tokens.accessToken, deps)
  await deps.writeCredentials({
    controlPlaneUrl: deps.controlPlaneUrl,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
    ...(tokens.expiresIn ? { expiresAt: deps.now() + tokens.expiresIn * 1000 } : {}),
    ...(who ? { identity: who } : {}),
  })
  deps.log(who ? `Signed in as ${who}` : "Signed in")
}
