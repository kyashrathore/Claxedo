import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { config, url } from "../config"
import { requestJson } from "../http"
import { number, object, text } from "../json"
import { requireAccessToken } from "../auth/token-store"
import { enrollmentPayload, heartbeatPayloadV2, loadMachineHostKey, type MachineHostKey } from "../keys/host-key"
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

/** Matches the lease the heartbeat interval in `host/runtime.ts` renews. */
const LEASE_TTL_MS = 60_000

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
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

function hostTunnel(input: unknown): HostTunnel {
  const row = object(input)
  const token = text(row.hostTunnelToken)
  if (!token) throw new Error("Control plane response is missing hostTunnel.hostTunnelToken")
  return {
    hostTunnelToken: token,
    ...(number(row.tokenExpiresAt) ? { tokenExpiresAt: number(row.tokenExpiresAt) } : {}),
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

/**
 * Enroll this MACHINE, once.
 *
 * Re-running is the normal case — every `claxedo up` calls it — and is safe:
 * the authority patches the existing row for the same `host_id` rather than
 * inserting a second, and a fresh nonce is signed each time (every signature
 * hash is single-use at the authority, so one can never be replayed).
 */
async function enrollMachine(input: { key: MachineHostKey; displayName: string; token: string }) {
  const cfg = config()
  const request = object(
    await requestJson({
      url: url(cfg.controlPlaneUrl, "/api/claxedo/host/enrollments/requests"),
      token: input.token,
      body: { hostId: input.key.hostId },
    }),
  )
  const requestId = text(request.request_id)
  const nonce = text(request.nonce)
  if (!requestId || !nonce) throw new Error("Enrollment request response is missing request_id or nonce")
  await requestJson({
    url: url(cfg.controlPlaneUrl, "/api/claxedo/host/enrollments"),
    token: input.token,
    body: {
      hostId: input.key.hostId,
      publicKey: input.key.publicKey,
      requestId,
      signature: input.key.sign(enrollmentPayload({ hostId: input.key.hostId, requestId, nonce })),
      displayName: input.displayName,
      ttlMs: LEASE_TTL_MS,
    },
  })
}

/**
 * Every workspace this machine currently serves.
 *
 * The heartbeat's signed set is MACHINE-wide, so a beat that named only the
 * calling process's workspace would revoke the consent of every other
 * `claxedo up` on this laptop — one enrollment, one acked set. `hosts.json` is
 * already this CLI's registry of what the machine serves (`claxedo down`
 * removes a record), so the union of its ids plus the caller's own is the
 * truthful answer.
 *
 * A record left by a crashed process keeps its id in the set. That grants
 * nothing on its own: routing also needs the owner's assignment AND a runtime
 * that answers, and the dead one answers nothing.
 */
async function servedWorkspaceIds(own: string) {
  const state = await readHostState()
  return [...new Set([own, ...state.hosts.map((record) => record.workspaceId)])].sort()
}

export async function registerHost(options: RegisterOptions): Promise<RegisteredHost> {
  const cfg = config()
  const directory = path.resolve(options.directory)
  const token = await requireAccessToken()
  const state = await readHostState()
  const existingRecord = state.hosts.find((item) => item.directory === directory)
  const existingWorkspace = await existingWorkspaceForDirectory(directory, token)
  const workspace = workspaceId(existingWorkspace) ?? existingRecord?.workspaceId ?? id("ws")
  const displayName =
    options.name ?? text(existingWorkspace?.display_name) ?? existingRecord?.displayName ?? repoName(directory)
  const key = await loadMachineHostKey()
  const gitBranch = git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
  const repoUrl = git(directory, ["config", "--get", "remote.origin.url"])

  // The machine's label is the machine's, not the project's: one enrollment
  // serves every workspace on this laptop, so naming it after whichever repo
  // happened to run `up` first would mislabel the device list.
  await enrollMachine({ key, displayName: os.hostname(), token })

  // The OWNER's declaration that this machine serves this workspace. Pure
  // data — no challenge and no signature here, because liveness is the
  // enrollment lease and consent is the heartbeat's acked set. Cold-registers
  // the workspace row when it does not exist yet.
  const assigned = object(
    await requestJson({
      url: url(cfg.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspace)}/host-assignment`),
      token,
      body: {
        hostId: key.hostId,
        displayName,
        repoName: repoName(directory),
        ...(repoUrl ? { repoUrl } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        remoteDirectory: directory,
      },
    }),
  )

  // The assignment already minted a credential, so serving starts without
  // waiting for a beat. Beats replace it with the one covering the whole
  // assigned-and-acked set.
  let tunnel = hostTunnel(assigned.hostTunnel)

  const heartbeat = async () => {
    const workspaceIds = await servedWorkspaceIds(workspace)
    const beat = object(
      await requestJson({
        url: url(cfg.controlPlaneUrl, "/api/claxedo/host/enrollments/heartbeat"),
        token: await requireAccessToken(),
        body: {
          hostId: key.hostId,
          signature: key.sign(heartbeatPayloadV2({ hostId: key.hostId, ttlMs: LEASE_TTL_MS, workspaceIds })),
          ttlMs: LEASE_TTL_MS,
          workspaceIds,
        },
      }),
    )
    const acked = Array.isArray(beat.assigned_workspace_ids) ? beat.assigned_workspace_ids : []
    if (!acked.includes(workspace)) {
      throw new Error(`The control plane no longer assigns ${workspace} to this machine`)
    }
    tunnel = hostTunnel(beat.hostTunnel)
    return tunnel
  }

  const relayUrl = tunnel.relayUrl ?? process.env.CLAXEDO_WORKSPACE_RELAY_URL
  if (!relayUrl)
    throw new Error("Host assignment response is missing hostTunnel.relayUrl and CLAXEDO_WORKSPACE_RELAY_URL is not set")
  return {
    workspaceId: workspace,
    hostId: key.hostId,
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
