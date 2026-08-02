import path from "node:path"
import { config, url } from "../config"
import { requestJson } from "../http"
import { number, object, readJsonFile, text, writePrivateJson } from "../json"

export type Credentials = {
  controlPlaneUrl: string
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: number
  identity?: string
}

function credentialsPath() {
  return path.join(config().stateDir, "credentials.json")
}

function credentials(input: unknown): Credentials | undefined {
  const row = object(input)
  const accessToken = text(row.accessToken) ?? text(row.access_token)
  if (!accessToken) return
  return {
    controlPlaneUrl: text(row.controlPlaneUrl) ?? config().controlPlaneUrl,
    accessToken,
    ...((text(row.refreshToken) ?? text(row.refresh_token))
      ? { refreshToken: text(row.refreshToken) ?? text(row.refresh_token) }
      : {}),
    ...((text(row.tokenType) ?? text(row.token_type))
      ? { tokenType: text(row.tokenType) ?? text(row.token_type) }
      : {}),
    ...(number(row.expiresAt) ? { expiresAt: number(row.expiresAt) } : {}),
    ...(text(row.identity) ? { identity: text(row.identity) } : {}),
  }
}

export async function readCredentials() {
  const fromFile = credentials(await readJsonFile(credentialsPath()))
  if (fromFile) return fromFile
  const token = text(process.env.CLAXEDO_DEV_TOKEN) ?? text(process.env.CLAXEDO_ACCESS_TOKEN)
  if (!token) return
  return {
    controlPlaneUrl: config().controlPlaneUrl,
    accessToken: token,
    identity: "dev-token",
  }
}

export async function writeCredentials(input: Credentials) {
  await writePrivateJson(credentialsPath(), input)
}

export async function removeCredentials() {
  await writePrivateJson(credentialsPath(), {})
}

function needsRefresh(input: Credentials) {
  return !!input.expiresAt && input.expiresAt - Date.now() < 60_000
}

function tokenResponse(input: unknown, current: Credentials): Credentials {
  const row = object(input)
  const accessToken = text(row.access_token) ?? text(row.accessToken)
  if (!accessToken) throw new Error("Token response is missing access_token")
  const expiresIn = number(row.expires_in) ?? number(row.expiresIn)
  return {
    controlPlaneUrl: current.controlPlaneUrl,
    accessToken,
    refreshToken: text(row.refresh_token) ?? text(row.refreshToken) ?? current.refreshToken,
    tokenType: text(row.token_type) ?? text(row.tokenType) ?? current.tokenType,
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(current.identity ? { identity: current.identity } : {}),
  }
}

export async function requireAccessToken() {
  const current = await readCredentials()
  if (!current) throw new Error("Not signed in. Run `claxedo login` or set CLAXEDO_DEV_TOKEN.")
  if (!needsRefresh(current)) return current.accessToken
  if (!current.refreshToken)
    throw new Error("Stored token expired and no refresh_token is available. Run `claxedo login` again.")
  const refreshed = tokenResponse(
    await requestJson({
      url: url(current.controlPlaneUrl, "/api/auth/device/token"),
      body: {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      },
    }),
    current,
  )
  await writeCredentials(refreshed)
  return refreshed.accessToken
}
