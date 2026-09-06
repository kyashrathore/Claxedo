import { spawn } from "node:child_process"
import { config, url } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { writeCredentials, type Credentials } from "./token-store"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"

type DeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalMs: number
  expiresAt: number
}

function deviceCode(input: unknown): DeviceCode {
  const row = object(input)
  const code = trimToUndefined(row.device_code) ?? trimToUndefined(row.deviceCode)
  const userCode = trimToUndefined(row.user_code) ?? trimToUndefined(row.userCode)
  const verificationUri = trimToUndefined(row.verification_uri) ?? trimToUndefined(row.verification_url) ?? trimToUndefined(row.verificationUrl)
  if (!code || !userCode || !verificationUri) {
    throw new Error("Device-code response is missing device_code, user_code, or verification URI")
  }
  return {
    deviceCode: code,
    userCode,
    verificationUri,
    ...((trimToUndefined(row.verification_uri_complete) ?? trimToUndefined(row.verificationUriComplete))
      ? { verificationUriComplete: trimToUndefined(row.verification_uri_complete) ?? trimToUndefined(row.verificationUriComplete) }
      : {}),
    intervalMs: Math.max(1, asFiniteNumber(row.interval) ?? 5) * 1000,
    expiresAt: Date.now() + Math.max(60, asFiniteNumber(row.expires_in) ?? 600) * 1000,
  }
}

function credential(input: unknown, controlPlaneUrl: string): Credentials {
  const row = object(input)
  const accessToken = trimToUndefined(row.access_token) ?? trimToUndefined(row.accessToken)
  if (!accessToken) throw new Error("Device-token response is missing access_token")
  const expiresIn = asFiniteNumber(row.expires_in) ?? asFiniteNumber(row.expiresIn)
  const identity = trimToUndefined(row.identity) ?? trimToUndefined(row.email) ?? trimToUndefined(row.subject) ?? trimToUndefined(row.user_id)
  return {
    controlPlaneUrl,
    accessToken,
    ...((trimToUndefined(row.refresh_token) ?? trimToUndefined(row.refreshToken))
      ? { refreshToken: trimToUndefined(row.refresh_token) ?? trimToUndefined(row.refreshToken) }
      : {}),
    ...((trimToUndefined(row.token_type) ?? trimToUndefined(row.tokenType))
      ? { tokenType: trimToUndefined(row.token_type) ?? trimToUndefined(row.tokenType) }
      : {}),
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(identity ? { identity } : {}),
  }
}

function openBrowser(target: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function login() {
  const cfg = config()
  const device = deviceCode(
    await requestJson({
      url: url(cfg.controlPlaneUrl, "/api/auth/device/code"),
      method: "POST",
      body: {},
    }),
  )
  const browserUrl = device.verificationUriComplete ?? device.verificationUri
  openBrowser(browserUrl)
  console.log(`Open ${browserUrl}`)
  console.log(`Enter code: ${device.userCode}`)

  let intervalMs = device.intervalMs
  while (Date.now() < device.expiresAt) {
    await sleep(intervalMs)
    try {
      const tokens = credential(
        await requestJson({
          url: url(cfg.controlPlaneUrl, "/api/auth/device/token"),
          method: "POST",
          body: { device_code: device.deviceCode },
        }),
        cfg.controlPlaneUrl,
      )
      await writeCredentials(tokens)
      console.log(tokens.identity ? `Signed in as ${tokens.identity}` : "Signed in")
      return
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : undefined
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        intervalMs += 5_000
        continue
      }
      throw err
    }
  }
  throw new Error("Device login expired. Run `claxedo login` again.")
}
