import { spawn } from "node:child_process"
import { config, url } from "../config"
import { requestJson } from "../http"
import { number, object, text } from "../json"
import { writeCredentials, type Credentials } from "./token-store"

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
  const code = text(row.device_code) ?? text(row.deviceCode)
  const userCode = text(row.user_code) ?? text(row.userCode)
  const verificationUri = text(row.verification_uri) ?? text(row.verification_url) ?? text(row.verificationUrl)
  if (!code || !userCode || !verificationUri) {
    throw new Error("Device-code response is missing device_code, user_code, or verification URI")
  }
  return {
    deviceCode: code,
    userCode,
    verificationUri,
    ...((text(row.verification_uri_complete) ?? text(row.verificationUriComplete))
      ? { verificationUriComplete: text(row.verification_uri_complete) ?? text(row.verificationUriComplete) }
      : {}),
    intervalMs: Math.max(1, number(row.interval) ?? 5) * 1000,
    expiresAt: Date.now() + Math.max(60, number(row.expires_in) ?? 600) * 1000,
  }
}

function credential(input: unknown, controlPlaneUrl: string): Credentials {
  const row = object(input)
  const accessToken = text(row.access_token) ?? text(row.accessToken)
  if (!accessToken) throw new Error("Device-token response is missing access_token")
  const expiresIn = number(row.expires_in) ?? number(row.expiresIn)
  const identity = text(row.identity) ?? text(row.email) ?? text(row.subject) ?? text(row.user_id)
  return {
    controlPlaneUrl,
    accessToken,
    ...((text(row.refresh_token) ?? text(row.refreshToken))
      ? { refreshToken: text(row.refresh_token) ?? text(row.refreshToken) }
      : {}),
    ...((text(row.token_type) ?? text(row.tokenType))
      ? { tokenType: text(row.token_type) ?? text(row.tokenType) }
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
