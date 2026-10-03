import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  createRuntimeCredentialIssuer,
  isLoopbackHostname,
  remoteWorkspaceSessionAccessPolicyFromEnv,
  WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL,
  workspaceRuntimeListenHostname,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import { isNativeHarnessId } from "@claxedo/server-core/agent-config/connections"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { storeBackedSessionPlacement, workspaceDir, workspaceId, workspaceRuntimeStoreDir } from "@claxedo/workspace-runtime/host"
import {
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "@claxedo/workspace-runtime/exposure"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"
import { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"
import { firstPartyMcpRuntimeContribution } from "./first-party-mcp"
import { sandboxConnectionSecrets } from "./connection-secrets"
import { configureRuntimeGitAuth } from "./git-auth"
import { workspaceRuntimeOwnerGrant } from "./owner-grant"
import { workspaceRuntimeTasksGrant } from "./tasks-grant"
import { cloudWorkspaceUsage, createSandboxUsageLedger } from "./cloud-usage"
import { cloudSessionRows } from "./cloud-session-rows"
import {
  sandboxLeaseEnv,
  workspaceRuntimeMcpToolGroups,
  workspaceRuntimeConfigTokenEnv,
  workspaceRuntimeTargetEnv,
} from "@claxedo/server-core/hosts/workspace-runtime/env"

export type ClaxedoWorkspaceRuntimeBoot = {
  port: number
  hostname: string
  options: WorkspaceRuntimeServerOptions
}

export function claxedoWorkspaceRuntimeLaunch(input: {
  workspaceId: string
  hostId: string
  leaseId: string
  epoch: number
  directory: string
  port: number
  credential: { token: string; expiresAt: number }
  now?: number
}) {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new Error("workspace-runtime launch requires a positive safe-integer lease epoch")
  }
  assertRuntimePort(input.port, "workspace-runtime launch port")
  if (!input.credential.token.trim()) throw new Error("workspace-runtime launch requires a bootstrap credential")
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error("workspace-runtime launch requires a finite current timestamp")
  if (!Number.isFinite(input.credential.expiresAt)) {
    throw new Error("workspace-runtime launch requires a finite bootstrap credential expiry")
  }
  if (input.credential.expiresAt <= now) {
    throw new Error("workspace-runtime bootstrap credential is expired")
  }
  return {
    command: ["workspace-runtime"],
    env: {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        directory: input.directory,
        port: input.port,
      }),
      ...sandboxLeaseEnv({
        leaseId: input.leaseId,
        epoch: input.epoch,
      }),
      ...workspaceRuntimeConfigTokenEnv({ token: input.credential.token }),
    },
  }
}

function text(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim()
  return value || undefined
}

/**
 * Claxedo's CORS origin policy for its workspace-runtime hosts. This is host
 * policy, not kit policy: the product whitelist lives here, keeping the kit
 * product-free. On loopback exposure it allows local dev
 * origins (`http://localhost:*`, `http://127.0.0.1:*`) plus the Claxedo app on
 * the configured HTTPS origin suffixes (CLAXEDO_ALLOWED_ORIGIN_SUFFIXES,
 * default `*.claxedo.com`); every other exposure allows nothing. Both Claxedo
 * hosts (the sandbox host below and the embedded host) pass this.
 */
export { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"

export function claxedoRuntimeHarnessFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceRuntimeServerOptions["harness"] {
  const nativeHarness = text(env, "WORKSPACE_RUNTIME_NATIVE_HARNESS")
  const connectionId = text(env, "WORKSPACE_RUNTIME_CONNECTION_ID")
  if (nativeHarness && connectionId) {
    throw new Error("Choose either WORKSPACE_RUNTIME_NATIVE_HARNESS or WORKSPACE_RUNTIME_CONNECTION_ID")
  }
  if (nativeHarness) {
    if (!isNativeHarnessId(nativeHarness)) {
      throw new Error(`Unsupported WORKSPACE_RUNTIME_NATIVE_HARNESS: ${nativeHarness}`)
    }
    return { kind: "native", harnessId: nativeHarness }
  }
  if (connectionId) return { kind: "connection", connectionId }
  return undefined
}

/**
 * Claxedo's boot policy for its workspace-runtime host: decode the env the
 * supervisor composed (`workspace-supervisor-runtime-env.ts` /
 * `hosts/workspace-runtime/env.ts`) into server options, applying
 * Claxedo's exposure ladder (relay when relay-host auth is present, loopback
 * on loopback hosts, dev-unsafe otherwise).
 *
 * This ladder is host policy — it deliberately lives with Claxedo, not in the
 * kit. Other hosts define their own ladder from the same kit parsers
 * (`workspaceRelayRuntimeOptionsFromEnv`, the exposure factories).
 */
export async function claxedoWorkspaceRuntimeBootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  input: { routeContributions?: readonly WorkspaceRuntimeRouteContribution[] } = {},
): Promise<ClaxedoWorkspaceRuntimeBoot> {
  const rawPort = text(env, "WORKSPACE_RUNTIME_PORT") ?? "3002"
  if (!/^\d+$/.test(rawPort)) throw new Error(`WORKSPACE_RUNTIME_PORT must be an integer: ${rawPort}`)
  const port = Number(rawPort)
  assertRuntimePort(port, "WORKSPACE_RUNTIME_PORT")
  const hostname = workspaceRuntimeListenHostname(env)
  const relayOptions = await workspaceRelayRuntimeOptionsFromEnv(env, port)
  const targetDirectory = workspaceDir(env)
  const harness = claxedoRuntimeHarnessFromEnv(env)
  await configureRuntimeGitAuth(env)
  // The owner the control plane launched this root for, presented on the
  // runtime's own session calls. Its unverified `user_id` names the actor in
  // the MCP audit trail; nothing here trusts it for more than that.
  const ownerGrant = workspaceRuntimeOwnerGrant(env)
  // One issuer per runtime process: it mints the bearer every session this
  // runtime launches carries, and its `verify` is both the endpoint's admission
  // check and the runtime's proof that the caller is a harness it started.
  const firstPartyMcp = createRuntimeCredentialIssuer({
    runtimeId: randomUUID(),
    workspaceId: workspaceId(env),
    ...(ownerGrant?.userId ? { userId: ownerGrant.userId } : {}),
  })
  // What this root's project consented to, as the control plane wrote it at
  // launch. A sandbox cannot ask again, and a variable that never arrived is
  // not consent, so an absent one leaves every group off.
  const enabledToolGroups = workspaceRuntimeMcpToolGroups(env) ?? []
  // Renewed for as long as the control plane will renew it; the host has no
  // later moment to start this at, and the timer holds nothing open.
  const tasks = workspaceRuntimeTasksGrant(env, ownerGrant ? { ownerGrant } : {})
  tasks?.start()
  const sessionRows = cloudSessionRows(env)
  // A relay-exposed runtime answers to the control plane's session authority,
  // which is also where its turns' usage is reported.
  const authorityUrl = text(env, WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL)
  const usageLedger = relayOptions.relayHostAuth && authorityUrl
    ? createSandboxUsageLedger({ path: path.join(workspaceRuntimeStoreDir(env), "usage.sqlite"), workspaceId: workspaceId(env) })
    : undefined
  const usage = usageLedger && authorityUrl
    ? cloudWorkspaceUsage({
        workspaceId: workspaceId(env),
        authorityUrl,
        ledger: usageLedger,
        policy: remoteWorkspaceSessionAccessPolicyFromEnv(env),
      })
    : undefined
  const options: WorkspaceRuntimeServerOptions = {
    ...storeBackedSessionPlacement(),
    ...(authorityUrl
      ? { resolveConnectionSecrets: sandboxConnectionSecrets({ workspaceId: workspaceId(env), authorityUrl }) }
      : {}),
    target: { workspaceId: workspaceId(env), directory: targetDirectory },
    firstPartyMcpLaunch: { baseUrl: `http://127.0.0.1:${port}`, issuer: firstPartyMcp, enabledToolGroups: () => enabledToolGroups },
    ...relayOptions,
    // Relay-host gating must come from env so a runtime spawned as a
    // subprocess (sandbox image) rejects unauthenticated direct access
    // without its parent passing options explicitly.
    exposure: relayOptions.relayHostAuth
      ? relayWorkspaceRuntimeExposure(relayOptions.relayHostAuth)
      : isLoopbackHostname(hostname)
        ? loopbackWorkspaceRuntimeExposure()
        : privateNetworkDevUnsafeWorkspaceRuntimeExposure(
          "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK local managed-cloud runtime",
        ),
    ...(harness ? { harness } : {}),
    ...(usage
      ? {
          sessionAccessPolicy: usage.sessionAccessPolicy,
          onTurnOutcome: usage.onTurnOutcome,
          bindSessionConfig: usage.bindSessionConfig,
          bindSessionParents: usage.bindSessionParents,
        }
      : {}),
    ...(usage || sessionRows
      ? {
          onPresentationEvent: (event) => {
            usage?.onPresentationEvent(event)
            sessionRows?.onPresentationEvent(event)
          },
          onDrain: async () => {
            sessionRows?.stop()
            await usage?.drain()
            usageLedger?.close()
          },
        }
      : {}),
    ...(sessionRows ? { bindSessionReads: sessionRows.bindSessionReads } : {}),
    // A sandbox is nobody's desktop: the owner's logins never reach it, and
    // every session runs on brokered credentials.
    placement: { placement: "cloud", machineOwnerUserId: ownerGrant?.userId ?? "", canUseOwnLogin: false },
    env,
    corsOrigin: claxedoCorsOrigin,
    // The host entry's route contributions (the Agent Plugins VM image mounts
    // its apply route this way). Accepting them without forwarding them left
    // the sandbox image answering 404 to the provisioner.
    routeContributions: [
      ...(input.routeContributions ?? []),
      firstPartyMcpRuntimeContribution({
        verifyRuntimeCredential: firstPartyMcp.verify,
        enabledToolGroups,
        tasks: () => tasks?.current(),
        ...(ownerGrant ? { ownerGrant: () => ownerGrant.current(), ownerActorId: () => ownerGrant.actorId } : {}),
      }),
    ],
  }
  return { port, hostname, options }
}

function assertRuntimePort(port: number, label: string) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
}
