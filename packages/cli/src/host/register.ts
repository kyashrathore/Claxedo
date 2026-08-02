import crypto from "node:crypto"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { config, url } from "../config"
import { requestJson } from "../http"
import { object, text } from "../json"
import { requireAccessToken } from "../auth/token-store"
import { heartbeatPayload, loadHostKey, registrationPayload } from "../keys/host-key"
import { readHostState } from "./state"

export type RegisteredHost = {
  workspaceId: string
  hostId: string
  displayName: string
  directory: string
  relayUrl: string
  hostTunnelToken: string
  tokenExpiresAt?: number
  heartbeat: () => Promise<HostTunnel>
  tokenProvider: () => Promise<string>
}

export type HostTunnel = {
  hostTunnelToken: string
  tokenExpiresAt?: number
  relayUrl?: string
}

type RegisterOptions = {
  directory: string
  name?: string
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`
}

function git(directory: string, args: string[]) {
  try {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

function repoName(directory: string) {
  const origin = git(directory, ["config", "--get", "remote.origin.url"])
  if (!origin) return path.basename(directory)
  return (
    origin
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .at(-1) ?? path.basename(directory)
  )
}

function challenge(input: unknown) {
  const row = object(object(input).challenge)
  const challengeId = text(row.challengeId)
  const nonce = text(row.nonce)
  if (!challengeId || !nonce) throw new Error("Challenge response is missing challengeId or nonce")
  return { challengeId, nonce }
}

function hostTunnel(input: unknown): HostTunnel {
  const row = object(input)
  const token = text(row.hostTunnelToken)
  if (!token) throw new Error("Register response is missing hostTunnel.hostTunnelToken")
  return {
    hostTunnelToken: token,
    ...(typeof row.tokenExpiresAt === "number" ? { tokenExpiresAt: row.tokenExpiresAt } : {}),
    ...(text(row.relayUrl) ? { relayUrl: text(row.relayUrl) } : {}),
  }
}

function workspaceId(input: unknown) {
  const row = object(input)
  return text(row.workspace_id) ?? text(row.workspaceId)
}

async function existingWorkspaceForDirectory(directory: string, token: string) {
  const response = object(
    await requestJson({
      url: url(config().controlPlaneUrl, "/api/workspace?access=user-hosted"),
      token,
    }),
  )
  const workspaces = Array.isArray(response.workspaces) ? response.workspaces : []
  return workspaces.map((item) => object(item)).find((item) => text(item.remote_directory) === directory)
}

export async function registerHost(options: RegisterOptions): Promise<RegisteredHost> {
  const cfg = config()
  const directory = path.resolve(options.directory)
  const token = await requireAccessToken()
  const state = await readHostState()
  const existingRecord = state.hosts.find((item) => item.directory === directory)
  const existingWorkspace = await existingWorkspaceForDirectory(directory, token)
  const workspace = workspaceId(existingWorkspace) ?? existingRecord?.workspaceId ?? id("ws")
  const hostId = existingRecord?.hostId ?? id("host")
  const displayName =
    options.name ?? text(existingWorkspace?.display_name) ?? existingRecord?.displayName ?? repoName(directory)
  const key = await loadHostKey(hostId)
  const gitBranch = git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
  const repoUrl = git(directory, ["config", "--get", "remote.origin.url"])
  const ch = challenge(
    await requestJson({
      url: url(cfg.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspace)}/user-hosted/challenge`),
      token,
      body: {
        hostId,
        displayName,
        ...(repoUrl ? { repoUrl } : {}),
        repoName: repoName(directory),
        ...(gitBranch ? { gitBranch } : {}),
      },
    }),
  )
  const registered = object(
    await requestJson({
      url: url(cfg.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspace)}/user-hosted/register`),
      token,
      body: {
        hostId,
        publicKey: key.publicKey,
        challengeId: ch.challengeId,
        signature: key.sign(
          registrationPayload({
            workspaceId: workspace,
            hostId,
            challengeId: ch.challengeId,
            nonce: ch.nonce,
          }),
        ),
        displayName,
        repoName: repoName(directory),
        ...(repoUrl ? { repoUrl } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        remoteDirectory: directory,
        ttlMs: 60_000,
      },
    }),
  )
  let tunnel = hostTunnel(registered.hostTunnel)
  const relayUrl = tunnel.relayUrl ?? process.env.CLAXEDO_WORKSPACE_RELAY_URL
  if (!relayUrl)
    throw new Error("Register response is missing hostTunnel.relayUrl and CLAXEDO_WORKSPACE_RELAY_URL is not set")
  const heartbeat = async () => {
    const next = object(
      await requestJson({
        url: url(cfg.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspace)}/user-hosted/heartbeat`),
        token: await requireAccessToken(),
        body: {
          hostId,
          signature: key.sign(heartbeatPayload({ workspaceId: workspace, hostId, ttlMs: 60_000 })),
          ttlMs: 60_000,
        },
      }),
    )
    tunnel = hostTunnel(next.hostTunnel)
    return tunnel
  }
  return {
    workspaceId: workspace,
    hostId,
    displayName,
    directory,
    relayUrl,
    hostTunnelToken: tunnel.hostTunnelToken,
    ...(tunnel.tokenExpiresAt ? { tokenExpiresAt: tunnel.tokenExpiresAt } : {}),
    heartbeat,
    tokenProvider: async () => {
      if (!tunnel.tokenExpiresAt || tunnel.tokenExpiresAt - Date.now() > 30_000) return tunnel.hostTunnelToken
      return (await heartbeat()).hostTunnelToken
    },
  }
}
