import path from "node:path"
import { config } from "../config"
import { trimToUndefined } from "@claxedo/helpers/string"
import {
  clearClaxedoCredentials,
  loadClaxedoCredentials,
  storeClaxedoCredentials,
} from "@claxedo/helpers/claxedo-credentials"
import { cliAuthBinding, type FetchLike } from "./auth-descriptor"
import { tokenRequest } from "./oauth"

/** The file's credential once this CLI's own control-plane default has filled in the origin. */
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

export async function readCredentials(): Promise<Credentials | undefined> {
  const fromFile = await loadClaxedoCredentials(credentialsPath())
  if (fromFile) return { ...fromFile, controlPlaneUrl: fromFile.controlPlaneUrl ?? config().controlPlaneUrl }
  const token = trimToUndefined(process.env.CLAXEDO_DEV_TOKEN) ?? trimToUndefined(process.env.CLAXEDO_ACCESS_TOKEN)
  if (!token) return undefined
  return {
    controlPlaneUrl: config().controlPlaneUrl,
    accessToken: token,
    identity: "dev-token",
  }
}

export async function writeCredentials(input: Credentials) {
  await storeClaxedoCredentials(input, credentialsPath())
}

export async function removeCredentials() {
  await clearClaxedoCredentials(credentialsPath())
}

function needsRefresh(input: Credentials, now: number) {
  return !!input.expiresAt && input.expiresAt - now < 60_000
}

/**
 * The `identity` the desktop writes when it mirrors its own credential into
 * this file (`cli-credential-file.ts`, `DESKTOP_CLI_IDENTITY`). That refresh
 * token was issued to the desktop's OAuth client, and a public client's
 * refresh must name the client the token belongs to.
 */
const DESKTOP_WRITTEN_IDENTITY = "claxedo-desktop"

export type RefreshDeps = { fetch?: FetchLike; now: () => number }

/** A refresh-token grant at the issuer's token endpoint, for the client that holds the refresh token. */
export async function refreshCredentials(current: Credentials, deps: RefreshDeps): Promise<Credentials> {
  if (!current.refreshToken) {
    throw new Error("Stored token expired and no refresh_token is available. Run `claxedo login` again.")
  }
  const binding = await cliAuthBinding(current.controlPlaneUrl, deps)
  const client = current.identity === DESKTOP_WRITTEN_IDENTITY ? binding.desktop : binding.cli
  const tokens = await tokenRequest({
    url: binding.tokenUrl,
    params: {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: client.clientId,
      resource: client.resource,
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })
  return {
    controlPlaneUrl: current.controlPlaneUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
    ...((tokens.tokenType ?? current.tokenType) ? { tokenType: tokens.tokenType ?? current.tokenType } : {}),
    ...(tokens.expiresIn ? { expiresAt: deps.now() + tokens.expiresIn * 1000 } : {}),
    ...(current.identity ? { identity: current.identity } : {}),
  }
}

export async function requireAccessToken() {
  const current = await readCredentials()
  if (!current) throw new Error("Not signed in. Run `claxedo login` or set CLAXEDO_DEV_TOKEN.")
  if (!needsRefresh(current, Date.now())) return current.accessToken
  const refreshed = await refreshCredentials(current, { now: () => Date.now() })
  await writeCredentials(refreshed)
  return refreshed.accessToken
}
