import path from "node:path"
import { config, url } from "../config"
import { requestJson } from "../http"
import { object, readOptionalJsonFile, writePrivateJson } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"

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
  const accessToken = trimToUndefined(row.accessToken) ?? trimToUndefined(row.access_token)
  if (!accessToken) return undefined
  return {
    controlPlaneUrl: trimToUndefined(row.controlPlaneUrl) ?? config().controlPlaneUrl,
    accessToken,
    ...((trimToUndefined(row.refreshToken) ?? trimToUndefined(row.refresh_token))
      ? { refreshToken: trimToUndefined(row.refreshToken) ?? trimToUndefined(row.refresh_token) }
      : {}),
    ...((trimToUndefined(row.tokenType) ?? trimToUndefined(row.token_type))
      ? { tokenType: trimToUndefined(row.tokenType) ?? trimToUndefined(row.token_type) }
      : {}),
    ...(asFiniteNumber(row.expiresAt) ? { expiresAt: asFiniteNumber(row.expiresAt) } : {}),
    ...(trimToUndefined(row.identity) ? { identity: trimToUndefined(row.identity) } : {}),
  }
}

export async function readCredentials(): Promise<Credentials | undefined> {
  const fromFile = credentials(await readOptionalJsonFile(credentialsPath()))
  if (fromFile) return fromFile
  const token = trimToUndefined(process.env.CLAXEDO_DEV_TOKEN) ?? trimToUndefined(process.env.CLAXEDO_ACCESS_TOKEN)
  if (!token) return undefined
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
  const accessToken = trimToUndefined(row.access_token) ?? trimToUndefined(row.accessToken)
  if (!accessToken) throw new Error("Token response is missing access_token")
  const expiresIn = asFiniteNumber(row.expires_in) ?? asFiniteNumber(row.expiresIn)
  return {
    controlPlaneUrl: current.controlPlaneUrl,
    accessToken,
    refreshToken: trimToUndefined(row.refresh_token) ?? trimToUndefined(row.refreshToken) ?? current.refreshToken,
    tokenType: trimToUndefined(row.token_type) ?? trimToUndefined(row.tokenType) ?? current.tokenType,
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
