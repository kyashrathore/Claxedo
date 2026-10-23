import { Hono, type Context } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { z } from "zod"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { ControlPlaneServices } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { admitMachineCaller, budgetExceeded, clientBudget } from "../../workspace/machine-caller"
import { machineHostEndpoints, parsedBody, type WorkspaceRouteOptions } from "../../workspace/route-support"
import {
  claxedoErrorResponse,
  parseJsonText,
  requestJsonThroughLimit,
  signedAccountHandler,
  tooLarge,
  unsupported,
  unsupportedError,
} from "../../workspace/host-route-support"
import { connectCommands } from "./connect-scripts"

const boundedText = (max: number) => z.string().trim().min(1).max(max)
const absolutePath = z.string().min(1).max(1_024)
const code = z.string().trim().min(1).max(64)
const machineFacts = z.object({
  hostname: boundedText(255),
  os: boundedText(64),
  arch: boundedText(32),
  cli_version: boundedText(64),
  folder: absolutePath,
  home: absolutePath.optional(),
}).strict()
const redeemBody = z.object({
  code,
  hostId: boundedText(200),
  publicKey: z.string().min(1).max(4_000),
  signature: z.string().min(1).max(4_000),
  machine: machineFacts,
}).strict()
const progressBody = z.object({ code, hostname: boundedText(255), os: boundedText(64) }).strict()
const folderBody = z.object({ enrollmentId: boundedText(200), hostId: boundedText(200), code, folder: absolutePath, home: absolutePath.optional() }).strict()
const selfBody = z.object({ enrollmentId: boundedText(200), hostId: boundedText(200) }).strict()
const approveBody = z.object({ displayName: boundedText(120).optional() }).strict()
const noBody = z.object({}).strict()

const BODY_LIMIT_BYTES = 8 * 1024
const DEFAULT_CODE_LIMIT = 5
const DEFAULT_CODE_WINDOW_MS = 60_000
const DEFAULT_ACCOUNT_LIMIT = 120
const DEFAULT_ACCOUNT_WINDOW_MS = 60_000
const DEFAULT_MINT_LIMIT = 10
const DEFAULT_CLIENT_LIMIT = 120

export type HostPairingRouteOptions = WorkspaceRouteOptions & {
  /** The public origin the connect commands fetch their script from and a machine's approval link opens. */
  controlPlaneOrigin: string
  now?: () => number
  codeRateLimiter?: ConnectionRateLimiter
  mintRateLimiter?: ConnectionRateLimiter
  controlPlaneRateLimiter?: ConnectionRateLimiter
  clientRateLimiter?: ConnectionRateLimiter
  machineRateLimiter?: ConnectionRateLimiter
}

function edgeCountry(c: Context): string | undefined {
  const cf = (c.req.raw as Request & { cf?: { country?: unknown } }).cf
  return typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : undefined
}

/**
 * `/api/claxedo/host/pairings`: the minting person's routes (mint, follow,
 * answer, cancel on sign-out), the routes a machine reaches with only its code
 * (install progress, redeem), and the machine-signed ones (share another
 * folder, read its own pairing while it waits).
 */
export function HostPairingRoutes(services: ControlPlaneServices, options: HostPairingRouteOptions) {
  const now = options.now ?? Date.now
  const limiter = (given: ConnectionRateLimiter | undefined, limit: number, windowMs: number) =>
    given ?? createFixedWindowConnectionRateLimiter({ limit, windowMs })
  const codeLimiter = limiter(options.codeRateLimiter, DEFAULT_CODE_LIMIT, DEFAULT_CODE_WINDOW_MS)
  const mintLimiter = limiter(options.mintRateLimiter, DEFAULT_MINT_LIMIT, DEFAULT_ACCOUNT_WINDOW_MS)
  const accountLimiter = limiter(options.controlPlaneRateLimiter, DEFAULT_ACCOUNT_LIMIT, DEFAULT_ACCOUNT_WINDOW_MS)
  const clientLimiter = limiter(options.clientRateLimiter, DEFAULT_CLIENT_LIMIT, DEFAULT_ACCOUNT_WINDOW_MS)
  const budgets = { clientRateLimiter: clientLimiter, machineRateLimiter: limiter(options.machineRateLimiter, DEFAULT_ACCOUNT_LIMIT, DEFAULT_ACCOUNT_WINDOW_MS), now }
  const handle = signedAccountHandler(services, options)
  const budget = (key: string) => ({ limiter: accountLimiter, key: `host.pairings.${key}`, action: `host_pairing.${key}.denied` })
  const changed = async (ownerUserId: string, pairingId: string) => { await options.machineChanged?.({ ownerUserId, pairingId }) }

  const byCode = <Schema extends z.ZodType<{ code: string }>>(schema: Schema, key: string, run: (body: z.infer<Schema>, authority: WorkspaceAuthority, c: Context) => Promise<Response>) =>
    async (c: Context) => {
      const limited = clientBudget(c, clientLimiter, `client:host.pairings.${key}`)
      if (limited) return limited
      const parsed = parsedBody(schema, await requestJsonThroughLimit(c))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      const perCode = codeLimiter.check({ userId: `pairing:${parsed.body.code}`, workspaceId: `host.pairings.${key}` })
      if (!perCode.allowed) return budgetExceeded(c, perCode.retryAfterMs)
      try {
        return await run(parsed.body, requireAuthority(services), c)
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }

  const signedMachine = <Schema extends z.ZodTypeAny>(schema: Schema, key: string, held: boolean, run: (body: z.infer<Schema>, machine: MachinePrincipal, authority: WorkspaceAuthority, c: Context) => Promise<Record<string, unknown>>) =>
    async (c: Context) => {
      const admitted = await admitMachineCaller(c, services, budgets, `host.pairings.${key}`, { admitHeld: held })
      if (admitted instanceof Response) return admitted
      const parsed = parsedBody(schema, parseJsonText(admitted.bodyText))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      try {
        return c.json(await run(parsed.body, admitted.machine, requireAuthority(services), c))
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }

  return new Hono()
    .post("/progress", tooLarge(BODY_LIMIT_BYTES), byCode(progressBody, "progress", async (body, authority, c) => {
      if (!authority.recordHostPairingProgress) return unsupported(c, "Machine pairing")
      const recorded = await authority.recordHostPairingProgress(body)
      await changed(recorded.ownerUserId, recorded.pairingId)
      return c.json({ recorded: true })
    }))
    .post("/redeem", tooLarge(BODY_LIMIT_BYTES), byCode(redeemBody, "redeem", async (body, authority, c) => {
      if (!authority.redeemHostPairing) return unsupported(c, "Machine pairing")
      const country = edgeCountry(c)
      const result = await authority.redeemHostPairing({ ...body, ...(country ? { country } : {}) })
      await changed(result.owner_user_id, result.pairing_id)
      return c.json({ ...result, approval_url: `${options.controlPlaneOrigin}/settings/machines`, ...machineHostEndpoints(options) })
    }))
    .post("/folder", tooLarge(BODY_LIMIT_BYTES), signedMachine(folderBody, "folder", false, async (body, machine, authority, c) => {
      if (!authority.requestHostPairingFolder) throw unsupportedError("Machine pairing")
      const country = edgeCountry(c)
      const self = await authority.requestHostPairingFolder(machine, { code: body.code, folder: body.folder, ...(body.home ? { home: body.home } : {}), ...(country ? { country } : {}) })
      await changed(machine.ownerUserId, self.pairing_id)
      return { ...self, approval_url: `${options.controlPlaneOrigin}/settings/machines` }
    }))
    .post("/self", tooLarge(BODY_LIMIT_BYTES), signedMachine(selfBody, "self", true, async (_body, machine, authority) => {
      if (!authority.hostPairingSelf) throw unsupportedError("Machine pairing")
      return { pairing: (await authority.hostPairingSelf(machine)) ?? null }
    }))
    .post("/", handle(noBody, async ({ auth, authority }) => {
      if (!authority.createHostPairing) throw unsupportedError("Machine pairing")
      await authority.usersMe(auth)
      const created = await authority.createHostPairing(auth)
      await authority.auditAllow(auth, { action: "host_pairing.created", metadata: { pairingId: created.pairingId, expiresAt: created.expiresAt } })
      return { pairing_id: created.pairingId, code: created.code, expires_at: created.expiresAt, commands: connectCommands(options.controlPlaneOrigin, created.code) }
    }, "POST", { limiter: mintLimiter, key: "host.pairings.create", action: "host_pairing.create.denied" }))
    .delete("/", handle(noBody, async ({ auth, authority }) => {
      if (!authority.cancelHostPairings) throw unsupportedError("Machine pairing")
      return await authority.cancelHostPairings(auth)
    }, "DELETE", budget("cancel")))
    .get("/", handle(noBody, async ({ auth, authority }) => {
      if (!authority.listHostPairingRequests) throw unsupportedError("Machine pairing")
      return { requests: await authority.listHostPairingRequests(auth) }
    }, "GET", budget("list")))
    .get("/:id", handle(noBody, async ({ auth, authority, c }) => {
      if (!authority.hostPairing) throw unsupportedError("Machine pairing")
      return { pairing: await authority.hostPairing(auth, { pairingId: routeParam(c, "id") }) }
    }, "GET", budget("read")))
    .post("/:id/approve", handle(approveBody, async ({ body, auth, authority, c }) => {
      if (!authority.approveHostPairing || !authority.recordHostPairingWorkspace) throw unsupportedError("Machine pairing")
      const pairingId = routeParam(c, "id")
      const approved = await authority.approveHostPairing(auth, { pairingId, ...(body.displayName ? { displayName: body.displayName } : {}) })
      const name = approved.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? approved.folder
      const workspaceId = approved.workspaceId ?? `ws_${crypto.randomUUID().replaceAll("-", "")}`
      await authority.assignWorkspaceHost(auth, { workspaceId, hostId: approved.hostId, displayName: name, repoName: name, remoteDirectory: approved.folder })
      const pairing = await authority.recordHostPairingWorkspace(auth, { pairingId, workspaceId })
      await authority.auditAllow(auth, { action: "host_pairing.approved", workspaceId, metadata: { pairingId, hostId: approved.hostId } })
      await options.hostChanged?.({ ownerUserId: approved.ownerUserId, hostId: approved.hostId })
      await changed(approved.ownerUserId, pairingId)
      return { pairing }
    }, "POST", budget("approve")))
    .post("/:id/deny", handle(noBody, async ({ auth, authority, c }) => {
      if (!authority.denyHostPairing || !authority.hostPairing) throw unsupportedError("Machine pairing")
      const pairingId = routeParam(c, "id")
      const denied = await authority.denyHostPairing(auth, { pairingId })
      await authority.auditAllow(auth, { action: "host_pairing.denied", metadata: { pairingId, hostId: denied.hostId } })
      if (denied.hostId) await options.hostChanged?.({ ownerUserId: denied.ownerUserId, hostId: denied.hostId })
      await changed(denied.ownerUserId, pairingId)
      return { pairing: await authority.hostPairing(auth, { pairingId }) }
    }, "POST", budget("deny")))
}
