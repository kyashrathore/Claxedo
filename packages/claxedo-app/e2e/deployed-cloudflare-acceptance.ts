/**
 * Two-user acceptance against a LIVE deployed Cloudflare control plane.
 *
 * Never part of CI: it signs into a real deployment with real GitHub accounts,
 * enrolls a machine, and opens a relay tunnel. Run on demand, one stage per
 * invocation, from `packages/claxedo-app`:
 *
 *   bun run test:e2e:deployed-cloudflare -- --capture-canary-identity
 *   bun run test:e2e:deployed-cloudflare -- --bootstrap-canary
 *   bun run test:e2e:deployed-cloudflare -- --capture-multiplayer-identities
 *   bun run test:e2e:deployed-cloudflare -- --run-multiplayer
 *
 * ## Environment
 *
 * Required for every stage:
 *   CLAXEDO_DEPLOYED_API_URL         Exact HTTPS origin of the deployed API
 *                                    (no path/query/credentials). Must differ
 *                                    from the app origin.
 *   CLAXEDO_DEPLOYED_APP_URL         Exact HTTPS origin of the deployed app.
 *   CLAXEDO_DEPLOYED_ACCEPTANCE_ID   Filesystem-safe run id; names the evidence
 *                                    directory under
 *                                    `.artifacts/deployed-cloudflare-acceptance/`.
 *
 * `--bootstrap-canary` additionally requires:
 *   CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE   Path to the owner-claim secret, mode
 *                                        0600 (refused otherwise).
 *
 * Optional:
 *   CLAXEDO_CANARY_JOURNEY_ID        Stamped onto phase headers for tracing.
 *
 * ## Credentials
 *
 * There are no credential environment variables by design. GitHub sign-in uses
 * two PERSISTENT Playwright profiles under the run's state root (`owner`,
 * `member`); a human completes the OAuth prompt once per profile and the
 * session is reused. The `capture-*` stages exist to establish and record
 * those identities before the run that spends them.
 *
 * ## Machine remote access
 *
 * `--run-multiplayer` exercises the enrollment grain end to end: nonce →
 * signed enroll → owner assignment (which cold-registers the workspace) →
 * heartbeat v2. Routing requires all three of owner assignment, the machine's
 * heartbeat-acked set, and a live lease, so the relay tunnel it opens is only
 * legitimate after the beat lands.
 *
 * The payload builders exported here are unit-gated offline by
 * `playwright/deployed-cloudflare-acceptance.test.ts`
 * (`bun run test:deployed-acceptance`), which talks to nothing.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto"
import { chromium, type BrowserContext } from "@playwright/test"
import { startWorkspaceRelayHostTunnel, type WorkspaceRelayHostTunnel } from "@claxedo/workspace-runtime/relay"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const OPERATIONS = ["private_session", "stream", "revocation", "wrong_org", "replay", "outage"] as const
type ValidationOperation = (typeof OPERATIONS)[number]
type Stage = "capture-canary-identity" | "bootstrap-canary" | "capture-multiplayer-identities" | "run-multiplayer"

type Environment = Record<string, string | undefined>

export type DeployedAcceptanceConfig = {
  apiOrigin: string
  appOrigin: string
  acceptanceId: string
  stateRoot: string
  ownerProfile: string
  memberProfile: string
}

type ProviderIdentity = {
  adapter: string
  issuer: string
  subject: string
}

type IdentityEvidence = {
  identity: ProviderIdentity
  identityHash: string
}

type MultiplayerIdentityEvidence = {
  owner: IdentityEvidence
  member: IdentityEvidence
}

type JsonRecord = Record<string, unknown>

function exactHttpsOrigin(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin`)
  }
  return url.origin
}

export function acceptanceConfig(
  env: Environment,
  appRoot = path.resolve(import.meta.dir, ".."),
): DeployedAcceptanceConfig {
  const acceptanceId = env.CLAXEDO_DEPLOYED_ACCEPTANCE_ID?.trim()
  if (!acceptanceId || !SAFE_ID.test(acceptanceId)) {
    throw new Error("CLAXEDO_DEPLOYED_ACCEPTANCE_ID must be a filesystem-safe release identifier")
  }
  const apiOrigin = exactHttpsOrigin(env.CLAXEDO_DEPLOYED_API_URL, "CLAXEDO_DEPLOYED_API_URL")
  const appOrigin = exactHttpsOrigin(env.CLAXEDO_DEPLOYED_APP_URL, "CLAXEDO_DEPLOYED_APP_URL")
  if (apiOrigin === appOrigin) throw new Error("deployed API and app origins must be distinct")
  const stateRoot = path.join(appRoot, ".artifacts", "deployed-cloudflare-acceptance", acceptanceId)
  return {
    apiOrigin,
    appOrigin,
    acceptanceId,
    stateRoot,
    ownerProfile: path.join(stateRoot, "owner-profile"),
    memberProfile: path.join(stateRoot, "member-profile"),
  }
}

/**
 * Machine-enrollment payload (v1).
 *
 * Byte-identical to the authority's verifier (`hostEnrollmentPayload` in
 * claxedo-server's `workspace/local-host.ts`, the D1/SQLite adapters and
 * the host-enrollment authority). Rebuilt here rather than imported because this
 * harness drives a DEPLOYED control plane over HTTP and must not link server
 * code; the literal is the contract, so drift fails at the first enrollment.
 */
export function enrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: ONE signature covers the lease renewal AND the workspaces this
 * machine serves (sorted, comma-joined). Byte-identical to
 * `hostEnrollmentHeartbeatPayloadV2`.
 */
export function heartbeatPayloadV2(input: {
  hostId: string
  ttlMs?: number
  workspaceIds: readonly string[]
}) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...input.workspaceIds].sort().join(",")}`,
  ].join("\n")
}

/**
 * A throwaway machine identity for one acceptance run.
 *
 * The private half never leaves this process — the deployed control plane
 * stores the public key and verifies signatures, which is the property the
 * enrollment handshake exists to prove.
 */
export function createMachineIdentity() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey
  return {
    publicKey: JSON.stringify(publicJwk),
    sign(payload: string) {
      return sign("sha256", Buffer.from(payload), {
        key: pair.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    },
  }
}

function selectedStage(argv: readonly string[]): Stage {
  const stages: Stage[] = [
    "capture-canary-identity",
    "bootstrap-canary",
    "capture-multiplayer-identities",
    "run-multiplayer",
  ]
  const selected = stages.filter((stage) => argv.includes(`--${stage}`))
  if (selected.length !== 1) {
    throw new Error(`select exactly one stage: ${stages.map((stage) => `--${stage}`).join(", ")}`)
  }
  return selected[0]!
}

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as JsonRecord
}

function textField(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing`)
  return value.trim()
}

function identityEvidence(value: unknown, name: string): IdentityEvidence {
  const body = record(value, name)
  const identity = record(body.identity, `${name}.identity`)
  return {
    identity: {
      adapter: textField(identity.adapter, `${name}.identity.adapter`),
      issuer: textField(identity.issuer, `${name}.identity.issuer`),
      subject: textField(identity.subject, `${name}.identity.subject`),
    },
    identityHash: textField(body.identityHash, `${name}.identityHash`),
  }
}

async function prepareState(config: DeployedAcceptanceConfig) {
  await fs.mkdir(config.stateRoot, { recursive: true, mode: 0o700 })
  await fs.chmod(config.stateRoot, 0o700)
}

async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(file, 0o600)
}

async function readPrivateJson(file: string) {
  const stat = await fs.stat(file)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must not be accessible by group or other users`)
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown
}

function phaseHeaders(
  stage: Stage,
  env: Environment,
  operation: ValidationOperation = "private_session",
): Record<string, string> {
  if (stage === "capture-canary-identity" || stage === "bootstrap-canary") {
    const journey = env.CLAXEDO_CANARY_JOURNEY_ID?.trim()
    if (!journey) throw new Error("CLAXEDO_CANARY_JOURNEY_ID is required for canary stages")
    return { "x-claxedo-canary-journey-id": journey }
  }
  return { "x-claxedo-multiplayer-validation-operation": operation }
}

async function launchProfile(
  config: DeployedAcceptanceConfig,
  profile: "owner" | "member",
  headers: Record<string, string>,
) {
  const userDataDir = profile === "owner" ? config.ownerProfile : config.memberProfile
  await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 })
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  })
  await context.route(`${config.apiOrigin}/**`, async (route) => {
    await route.continue({ headers: { ...route.request().headers(), ...headers } })
  })
  return context
}

async function currentSession(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  headers: Record<string, string>,
) {
  const response = await fetch(`${config.apiOrigin}/api/auth/get-session`, {
    headers: { ...headers, cookie: await cookieHeader(context, config.apiOrigin) },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return undefined
  const body = (await response.json().catch(() => undefined)) as unknown
  const user = body && typeof body === "object" ? (body as JsonRecord).user : undefined
  if (!user || typeof user !== "object") return undefined
  const id = (user as JsonRecord).id
  return typeof id === "string" && id ? body : undefined
}

async function ensureGithubSession(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  headers: Record<string, string>,
  label: string,
) {
  const existing = await currentSession(context, config, headers)
  if (existing) return existing
  const page = context.pages()[0] ?? (await context.newPage())
  const started = await fetch(`${config.apiOrigin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { ...headers, origin: config.appOrigin, "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: config.appOrigin, disableRedirect: true }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  if (!started.ok) throw new Error(`${label} GitHub OAuth start failed with HTTP ${started.status}`)
  const setCookie = started.headers.get("set-cookie")
  const cookiePair = setCookie?.split(";", 1)[0]
  const separator = cookiePair?.indexOf("=") ?? -1
  if (!cookiePair || separator <= 0) throw new Error(`${label} OAuth response omitted its state cookie`)
  await context.addCookies([
    {
      name: cookiePair.slice(0, separator),
      value: cookiePair.slice(separator + 1),
      url: config.apiOrigin,
      httpOnly: /;\s*HttpOnly(?:;|$)/i.test(setCookie),
      secure: /;\s*Secure(?:;|$)/i.test(setCookie),
      sameSite: /;\s*SameSite=Strict(?:;|$)/i.test(setCookie)
        ? "Strict"
        : /;\s*SameSite=None(?:;|$)/i.test(setCookie)
          ? "None"
          : "Lax",
    },
  ])
  const startBody = record(await started.json(), `${label} OAuth response`)
  const authorizationUrl = textField(startBody.url, `${label} OAuth response.url`)
  await page.goto(authorizationUrl)
  process.stdout.write(`Complete GitHub OAuth in the ${label} browser window. Waiting up to 10 minutes...\n`)
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const session = await currentSession(context, config, headers).catch(() => undefined)
    if (session) return session
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`${label} GitHub OAuth did not complete within 10 minutes`)
}

async function cookieHeader(context: BrowserContext, apiOrigin: string) {
  const cookies = await context.cookies(apiOrigin)
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}

async function apiRequest(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  stage: Stage,
  env: Environment,
  operation: ValidationOperation,
  route: string,
  init: RequestInit = {},
) {
  const method = (init.method ?? "GET").toUpperCase()
  const headers = new Headers(init.headers)
  headers.set("accept", "application/json")
  headers.set("cookie", await cookieHeader(context, config.apiOrigin))
  headers.set("origin", config.appOrigin)
  for (const [name, value] of Object.entries(phaseHeaders(stage, env, operation))) headers.set(name, value)
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(`${config.apiOrigin}${route}`, {
    ...init,
    method,
    headers,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
}

async function jsonRequest(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  stage: Stage,
  env: Environment,
  operation: ValidationOperation,
  route: string,
  init: RequestInit = {},
  expected: readonly number[] = [200],
) {
  const response = await apiRequest(context, config, stage, env, operation, route, init)
  const body = (await response.json().catch(() => undefined)) as unknown
  if (!expected.includes(response.status)) {
    const code =
      body && typeof body === "object" ? ((body as JsonRecord).error as JsonRecord | undefined)?.code : undefined
    throw new Error(
      `${init.method ?? "GET"} ${route} returned HTTP ${response.status}${typeof code === "string" ? ` (${code})` : ""}`,
    )
  }
  return body
}

/**
 * This owner's user-hosted workspace row, or undefined.
 *
 * The list is the only signed read that answers "does this workspace exist for
 * me", and the acceptance run needs it twice: absent after enrollment, present
 * after assignment. Those two answers together ARE the cold-registration
 * proof.
 */
async function userHostedWorkspace(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  env: Environment,
  workspaceId: string,
) {
  const body = record(
    await jsonRequest(context, config, "run-multiplayer", env, "private_session", "/api/workspace?access=user-hosted"),
    "user-hosted workspace list",
  )
  const rows = Array.isArray(body.workspaces) ? body.workspaces : []
  return rows
    .map((row) => (row && typeof row === "object" && !Array.isArray(row) ? (row as JsonRecord) : undefined))
    .find((row) => row?.workspace_id === workspaceId || row?.workspaceId === workspaceId)
}

async function discoverIdentity(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  stage: Stage,
  env: Environment,
) {
  const route = stage === "capture-canary-identity" ? "/__release/canary/identity" : "/__release/multiplayer/identity"
  return identityEvidence(await jsonRequest(context, config, stage, env, "private_session", route), route)
}

async function captureCanaryIdentity(config: DeployedAcceptanceConfig, env: Environment) {
  const headers = phaseHeaders("capture-canary-identity", env)
  const owner = await launchProfile(config, "owner", headers)
  try {
    await ensureGithubSession(owner, config, headers, "owner")
    const evidence = await discoverIdentity(owner, config, "capture-canary-identity", env)
    const file = path.join(config.stateRoot, "canary-identity.json")
    await writePrivateJson(file, evidence)
    process.stdout.write(`Canary identity captured at ${file}.\n`)
  } finally {
    await owner.close()
  }
}

async function bootstrapCanary(config: DeployedAcceptanceConfig, env: Environment) {
  const claimFile = env.CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE?.trim()
  if (!claimFile) throw new Error("CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE is required")
  const claimStat = await fs.stat(claimFile)
  if ((claimStat.mode & 0o077) !== 0) throw new Error("owner claim file must be mode 0600")
  const claim = (await fs.readFile(claimFile, "utf8")).trim()
  if (!claim) throw new Error("owner claim file is empty")
  const headers = phaseHeaders("bootstrap-canary", env)
  const owner = await launchProfile(config, "owner", headers)
  try {
    await ensureGithubSession(owner, config, headers, "owner")
    const operationId = `canary-bootstrap-${config.acceptanceId}`
    const profile = await jsonRequest(
      owner,
      config,
      "bootstrap-canary",
      env,
      "private_session",
      "/api/claxedo/auth/bootstrap-owner",
      {
        method: "POST",
        headers: {
          "x-claxedo-bootstrap-owner-claim": claim,
          "x-claxedo-canary-mutation-operation-id": operationId,
        },
      },
    )
    await writePrivateJson(path.join(config.stateRoot, "canary-complete.json"), {
      acceptanceId: config.acceptanceId,
      operationId,
      profile,
      completedAt: new Date().toISOString(),
    })
    process.stdout.write("Owner bootstrap and authenticated canary profile passed.\n")
  } finally {
    await owner.close()
  }
}

async function captureMultiplayerIdentities(config: DeployedAcceptanceConfig, env: Environment) {
  const headers = phaseHeaders("capture-multiplayer-identities", env)
  const owner = await launchProfile(config, "owner", headers)
  const member = await launchProfile(config, "member", headers)
  try {
    await ensureGithubSession(owner, config, headers, "owner")
    const ownerIdentity = await discoverIdentity(owner, config, "capture-multiplayer-identities", env)
    await ensureGithubSession(member, config, headers, "member (use a different GitHub account)")
    const memberIdentity = await discoverIdentity(member, config, "capture-multiplayer-identities", env)
    if (ownerIdentity.identityHash === memberIdentity.identityHash) {
      throw new Error("owner and member browser profiles authenticated the same GitHub identity")
    }
    const evidence: MultiplayerIdentityEvidence = { owner: ownerIdentity, member: memberIdentity }
    const file = path.join(config.stateRoot, "multiplayer-identities.json")
    await writePrivateJson(file, evidence)
    process.stdout.write(`Two distinct multiplayer identity hashes captured at ${file}.\n`)
  } finally {
    await Promise.all([owner.close(), member.close()])
  }
}

function identifierPrefix(acceptanceId: string) {
  return acceptanceId.replace(/[^A-Za-z0-9]/g, "_").slice(0, 48)
}

function arrayField(value: unknown, name: string) {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`)
  return value
}

function sessionIds(value: unknown) {
  const body = record(value, "session inventory")
  return arrayField(body.sessions, "session inventory.sessions")
    .map((row) => record(row, "session inventory row"))
    .map((row) => (typeof row.session_id === "string" ? row.session_id : typeof row.id === "string" ? row.id : ""))
    .filter(Boolean)
}

type SseFrame = { id?: string; data: JsonRecord }

class SseReader {
  private buffer = ""
  private readonly decoder = new TextDecoder()

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(timeoutMs = 10_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match?.index !== undefined) {
        const block = this.buffer.slice(0, match.index)
        this.buffer = this.buffer.slice(match.index + match[0].length)
        const lines = block.split(/\r?\n/)
        const id = lines
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim()
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        return { ...(id ? { id } : {}), data: record(JSON.parse(data), "SSE data") }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("timed out waiting for SSE frame")
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for SSE frame")), remaining),
        ),
      ])
      if (result.done) throw new Error("SSE stream ended before the expected frame")
      this.buffer += this.decoder.decode(result.value, { stream: true })
    }
  }

  cancel() {
    return this.reader.cancel()
  }
}

async function openSse(
  context: BrowserContext,
  config: DeployedAcceptanceConfig,
  env: Environment,
  operation: ValidationOperation,
  lastEventId?: string,
) {
  const response = await apiRequest(context, config, "run-multiplayer", env, operation, "/api/claxedo/events", {
    headers: { accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
    signal: AbortSignal.timeout(90_000),
  })
  if (response.status !== 200 || !response.body) throw new Error(`live-sync stream returned HTTP ${response.status}`)
  return { response, stream: new SseReader(response.body.getReader()) }
}

async function startAcceptanceTunnel(input: {
  relayUrl: string
  workspaceId: string
  hostId: string
  token: string
  localBaseUrl: string
  region?: string
}) {
  return new Promise<WorkspaceRelayHostTunnel>((resolve, reject) => {
    let tunnel: WorkspaceRelayHostTunnel
    const timeout = setTimeout(() => {
      tunnel?.close()
      reject(new Error("host tunnel did not open within 20 seconds"))
    }, 20_000)
    tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: input.relayUrl,
      hostId: input.hostId,
      workspaceIds: [input.workspaceId],
      localBaseUrl: input.localBaseUrl,
      ...(input.region ? { region: input.region } : {}),
      tokenProvider: async () => input.token,
      pingIntervalMs: 5_000,
      reconnectIntervalMs: 500,
      onEvent(event) {
        if (event.type === "open") {
          clearTimeout(timeout)
          resolve(tunnel)
        } else if (event.type === "auth-failed") {
          clearTimeout(timeout)
          tunnel.close()
          reject(new Error("host tunnel authentication failed"))
        }
      },
    })
  })
}

async function waitForRelayStatus(relayUrl: string, token: string, expected: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  while (Date.now() < deadline) {
    const response = await fetch(`${relayUrl}/api/wr/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    lastStatus = response?.status ?? 0
    if (lastStatus === expected) return response!
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`relay health did not reach HTTP ${expected}; last status was ${lastStatus}`)
}

async function runMultiplayer(config: DeployedAcceptanceConfig, env: Environment) {
  const evidenceFile = path.join(config.stateRoot, "multiplayer-identities.json")
  const stored = record(await readPrivateJson(evidenceFile), "multiplayer identity evidence")
  const expected: MultiplayerIdentityEvidence = {
    owner: identityEvidence(stored.owner, "owner identity evidence"),
    member: identityEvidence(stored.member, "member identity evidence"),
  }
  const headers = phaseHeaders("run-multiplayer", env)
  const owner = await launchProfile(config, "owner", headers)
  const member = await launchProfile(config, "member", headers)
  let activeTunnel: WorkspaceRelayHostTunnel | undefined
  let localRuntime: ReturnType<typeof Bun.serve> | undefined
  try {
    await ensureGithubSession(owner, config, headers, "owner")
    await ensureGithubSession(member, config, headers, "member")
    const [ownerLive, memberLive] = await Promise.all([
      discoverIdentity(owner, config, "run-multiplayer", env),
      discoverIdentity(member, config, "run-multiplayer", env),
    ])
    if (
      ownerLive.identityHash !== expected.owner.identityHash ||
      memberLive.identityHash !== expected.member.identityHash
    ) {
      throw new Error("live browser identities do not match the two operator-registered identity hashes")
    }

    const admitted = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        "/api/control/user-deployed/identity-admissions",
        { method: "POST", body: JSON.stringify({ subject: memberLive.identity.subject, role: "member" }) },
      ),
      "identity admission",
    )
    const admittedUser = record(admitted.user, "identity admission.user")
    const memberUserId = textField(admittedUser.id, "identity admission.user.id")

    const [ownerProfile, memberProfile] = await Promise.all([
      jsonRequest(owner, config, "run-multiplayer", env, "private_session", "/api/claxedo/auth/profile"),
      jsonRequest(member, config, "run-multiplayer", env, "private_session", "/api/claxedo/auth/profile"),
    ])
    const ownerOrganizations = arrayField(record(ownerProfile, "owner profile").organizations, "owner organizations")
    const memberOrganizations = arrayField(
      record(memberProfile, "member profile").organizations,
      "member organizations",
    )
    if (ownerOrganizations.length !== 1 || memberOrganizations.length !== 1) {
      throw new Error("user-deployed acceptance requires exactly one organization for both users")
    }
    const orgId = textField(record(ownerOrganizations[0], "owner organization").id, "owner organization.id")
    if (textField(record(memberOrganizations[0], "member organization").id, "member organization.id") !== orgId) {
      throw new Error("owner and member did not resolve to the same deployment organization")
    }

    const prefix = identifierPrefix(config.acceptanceId)
    const workspaceId = `ws_cf_${prefix}`
    const hostId = `host_cf_${prefix}`
    const sessionId = `ses_cf_${prefix}`
    const operationId = `op_cf_${prefix}`
    const machine = createMachineIdentity()

    // 1. One-use nonce for THIS machine. Carries no workspace: enrollment is
    //    machine-wide, which is the whole point of the grain.
    const requestBody = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        "/api/claxedo/host/enrollments/requests",
        { method: "POST", body: JSON.stringify({ hostId }) },
      ),
      "machine enrollment request",
    )
    const requestId = textField(requestBody.request_id, "enrollment request.request_id")
    const nonce = textField(requestBody.nonce, "enrollment request.nonce")

    // 2. Prove possession of the machine key. Enrolling creates no workspace —
    //    asserted below, because "enrolling a laptop creates nothing to own"
    //    is the property that distinguishes this from the retired flow.
    const enrolledBody = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        "/api/claxedo/host/enrollments",
        {
          method: "POST",
          body: JSON.stringify({
            hostId,
            publicKey: machine.publicKey,
            requestId,
            signature: machine.sign(enrollmentPayload({ hostId, requestId, nonce })),
            displayName: `Cloudflare acceptance ${config.acceptanceId}`,
          }),
        },
      ),
      "machine enrollment",
    )
    const enrollment = record(enrolledBody.enrollment, "machine enrollment.enrollment")
    if (textField(enrollment.host_id, "enrollment.host_id") !== hostId) {
      throw new Error("enrollment returned a different host id than the one enrolled")
    }
    if (await userHostedWorkspace(owner, config, env, workspaceId)) {
      throw new Error("enrolling a machine created a workspace, which it must never do")
    }

    // 3. The OWNER's assignment cold-registers the workspace and mints the
    //    first serving credential — no challenge and no machine signature,
    //    because liveness is the lease and consent is the acked set.
    const assignedBody = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        `/api/workspace/${workspaceId}/host-assignment`,
        {
          method: "POST",
          body: JSON.stringify({
            orgId,
            hostId,
            displayName: `Cloudflare acceptance ${config.acceptanceId}`,
          }),
        },
      ),
      "cold workspace host assignment",
    )
    const assignment = record(assignedBody.assignment, "host assignment.assignment")
    if (
      assignment.assigned !== true
      || textField(assignment.workspace_id, "assignment.workspace_id") !== workspaceId
      || textField(assignment.host_id, "assignment.host_id") !== hostId
    ) {
      throw new Error("host assignment did not return the assigned workspace/host pair")
    }

    // 4. One beat: the signed served set IS the machine's consent, and the ack
    //    carries back the owner's assignment view plus the credential for
    //    assigned∩acked. Routing needs all three, so the tunnel below is only
    //    legitimate once this beat has landed.
    const beat = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        "/api/claxedo/host/enrollments/heartbeat",
        {
          method: "POST",
          body: JSON.stringify({
            hostId,
            signature: machine.sign(heartbeatPayloadV2({ hostId, workspaceIds: [workspaceId] })),
            workspaceIds: [workspaceId],
          }),
        },
      ),
      "machine heartbeat",
    )
    const ackedAssignments = Array.isArray(beat.assigned_workspace_ids) ? beat.assigned_workspace_ids : undefined
    if (!ackedAssignments?.includes(workspaceId)) {
      throw new Error("heartbeat ack did not report the workspace as owner-assigned")
    }
    if (typeof beat.expires_at !== "number" || typeof beat.last_seen_at !== "number") {
      throw new Error("heartbeat ack is missing expires_at/last_seen_at")
    }

    // The ack mints a serving credential too, for exactly the assigned∩acked
    // set. Asserted rather than used: the tunnel below runs on the assignment's
    // credential, and this proves the steady-state renewal path issues one.
    const ackTunnel = record(beat.hostTunnel, "heartbeat ack.hostTunnel")
    const ackWorkspaceIds = Array.isArray(ackTunnel.workspaceIds) ? ackTunnel.workspaceIds : undefined
    if (!ackWorkspaceIds?.includes(workspaceId)) {
      throw new Error("heartbeat ack credential does not cover the assigned workspace")
    }

    // Cold registration is only proven by the workspace EXISTING now, since it
    // did not before the assignment.
    const workspace = record(
      await userHostedWorkspace(owner, config, env, workspaceId),
      "cold workspace registration.workspace",
    )
    const projectId = textField(workspace.project_id ?? workspace.projectId, "workspace.project_id")
    const hostTunnel = record(assignedBody.hostTunnel, "cold workspace assignment.hostTunnel")
    const hostTunnelToken = textField(hostTunnel.hostTunnelToken, "hostTunnel.hostTunnelToken")
    const relayUrl = textField(hostTunnel.relayUrl, "hostTunnel.relayUrl")
    const homeRegion = typeof hostTunnel.homeRegion === "string" ? hostTunnel.homeRegion : undefined
    let relayHostAuthorization: string | undefined
    localRuntime = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        relayHostAuthorization = request.headers.get("authorization") ?? undefined
        return Response.json({ status: "ok", path: new URL(request.url).pathname })
      },
    })
    activeTunnel = await startAcceptanceTunnel({
      relayUrl,
      workspaceId,
      hostId,
      token: hostTunnelToken,
      localBaseUrl: localRuntime.url.origin,
      ...(homeRegion ? { region: homeRegion } : {}),
    })
    const connection = record(
      await jsonRequest(owner, config, "run-multiplayer", env, "outage", `/api/workspace/${workspaceId}/connection`),
      "workspace connection",
    )
    const runtimeAccessToken = textField(connection.runtimeAccessToken, "workspace connection.runtimeAccessToken")
    const connectionRelayUrl = textField(connection.relayUrl, "workspace connection.relayUrl")
    if (connectionRelayUrl !== relayUrl)
      throw new Error("workspace connection and host registration disagree on relay origin")
    await waitForRelayStatus(relayUrl, runtimeAccessToken, 200)
    const relayHostToken = textField(relayHostAuthorization?.replace(/^Bearer\s+/i, ""), "relay-generated host proof")

    const team = record(
      await jsonRequest(
        owner,
        config,
        "run-multiplayer",
        env,
        "private_session",
        `/api/control/orgs/${orgId}/ensure-default-team`,
        { method: "POST", body: "{}" },
      ),
      "default team",
    )
    const teamId = textField(team.team_id ?? team.teamId, "default team.team_id")
    await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "private_session",
      `/api/control/teams/${teamId}/members`,
      { method: "POST", body: JSON.stringify({ userPublicId: memberUserId, role: "member" }) },
    )
    await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "private_session",
      `/api/control/teams/${teamId}/projects`,
      { method: "POST", body: JSON.stringify({ projectId, role: "editor" }) },
    )

    await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "private_session",
      "/api/control/session-registrations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          operationId,
          sessionId,
          workspaceId,
          kind: "create",
          title: "Cloudflare private session",
        }),
      },
      [200, 201],
    )
    await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "private_session",
      "/api/runtime-authority/session-authorize",
      {
        method: "POST",
        headers: { authorization: `Bearer ${relayHostToken}` },
        body: JSON.stringify({ operationId, sessionId, action: "register", title: "Cloudflare private session" }),
      },
    )

    const beforeShare = await jsonRequest(
      member,
      config,
      "run-multiplayer",
      env,
      "private_session",
      `/api/control/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
    )
    if (sessionIds(beforeShare).includes(sessionId))
      throw new Error("private session was visible before its share grant")

    const stream = await openSse(member, config, env, "stream")
    const heartbeat = await stream.stream.next()
    if (heartbeat.data.type !== "heartbeat") throw new Error("live-sync stream did not begin with a heartbeat")
    const grant = record(
      await jsonRequest(owner, config, "run-multiplayer", env, "stream", `/api/control/sessions/${sessionId}/shares`, {
        method: "POST",
        body: JSON.stringify({ workspaceId, grantedToTeamId: teamId }),
      }),
      "session share grant",
    )
    const grantId = textField(grant.grant_id ?? grant.grantId, "session share grant id")
    const grantedFrame = await stream.stream.next()
    if (grantedFrame.data.type !== "session.share.changed" || grantedFrame.data.phase !== "granted") {
      throw new Error("member stream did not receive the granted session-share event")
    }
    if (!grantedFrame.id) throw new Error("session-share stream event did not carry a replay cursor")

    const afterShare = await jsonRequest(
      member,
      config,
      "run-multiplayer",
      env,
      "private_session",
      `/api/control/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
    )
    if (!sessionIds(afterShare).includes(sessionId))
      throw new Error("shared session was not visible to the team member")

    const wrongOrgCreate = await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "wrong_org",
      "/api/control/orgs",
      { method: "POST", body: JSON.stringify({ name: "Forbidden second organization" }) },
      [403],
    )
    const wrongOrgCode = (record(wrongOrgCreate, "wrong-org response").error as JsonRecord | undefined)?.code
    if (wrongOrgCode !== "organization_policy_denied")
      throw new Error("second organization was not rejected by user-deployed policy")

    const replay = await openSse(member, config, env, "replay", grantedFrame.id)
    const replayHeartbeat = await replay.stream.next()
    if (replayHeartbeat.data.type !== "heartbeat") throw new Error("replay stream did not begin with a heartbeat")

    await jsonRequest(
      owner,
      config,
      "run-multiplayer",
      env,
      "revocation",
      `/api/control/sessions/${sessionId}/shares`,
      { method: "DELETE", body: JSON.stringify({ workspaceId, grantId }) },
    )
    const revokedFrame = await replay.stream.next()
    if (revokedFrame.data.type !== "session.share.changed" || revokedFrame.data.phase !== "revoked") {
      throw new Error("reconnected member stream did not receive revocation as its next data event")
    }
    if (revokedFrame.id === grantedFrame.id) throw new Error("replay cursor repeated an already-delivered grant event")
    await stream.stream.cancel()
    await replay.stream.cancel()

    const afterRevoke = await jsonRequest(
      member,
      config,
      "run-multiplayer",
      env,
      "revocation",
      `/api/control/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
    )
    if (sessionIds(afterRevoke).includes(sessionId)) throw new Error("revoked session remained visible to the member")

    activeTunnel.close()
    activeTunnel = undefined
    const offline = await waitForRelayStatus(relayUrl, runtimeAccessToken, 503)
    activeTunnel = await startAcceptanceTunnel({
      relayUrl,
      workspaceId,
      hostId,
      token: hostTunnelToken,
      localBaseUrl: localRuntime.url.origin,
      ...(homeRegion ? { region: homeRegion } : {}),
    })
    const recoveredConnection = record(
      await jsonRequest(owner, config, "run-multiplayer", env, "outage", `/api/workspace/${workspaceId}/connection`),
      "recovered workspace connection",
    )
    const recoveredRuntimeAccessToken = textField(
      recoveredConnection.runtimeAccessToken,
      "recovered workspace connection.runtimeAccessToken",
    )
    const recovered = await waitForRelayStatus(relayUrl, recoveredRuntimeAccessToken, 200)

    const result = {
      acceptanceId: config.acceptanceId,
      deployment: { apiOrigin: config.apiOrigin, appOrigin: config.appOrigin },
      identities: { owner: ownerLive.identityHash, member: memberLive.identityHash },
      organization: { id: orgId, exactlyOne: true },
      workspace: { id: workspaceId, projectId, coldRegistration: "passed" },
      team: { id: teamId, memberUserId, projectRole: "editor" },
      session: {
        id: sessionId,
        privateBeforeGrant: true,
        visibleAfterGrant: true,
        hiddenAfterRevoke: true,
      },
      validations: {
        private_session: "passed",
        stream: "passed",
        revocation: "passed",
        wrong_org: "passed",
        replay: "passed",
        outage: { offlineStatus: offline.status, recoveredStatus: recovered.status },
      },
      completedAt: new Date().toISOString(),
    }
    const resultFile = path.join(config.stateRoot, "multiplayer-complete.json")
    await writePrivateJson(resultFile, result)
    process.stdout.write(`Deployed two-user Cloudflare acceptance passed. Evidence: ${resultFile}\n`)
  } finally {
    activeTunnel?.close()
    localRuntime?.stop(true)
    await Promise.all([owner.close(), member.close()])
  }
}

async function main() {
  const config = acceptanceConfig(process.env)
  const stage = selectedStage(process.argv.slice(2))
  await prepareState(config)
  if (stage === "capture-canary-identity") return captureCanaryIdentity(config, process.env)
  if (stage === "bootstrap-canary") return bootstrapCanary(config, process.env)
  if (stage === "capture-multiplayer-identities") return captureMultiplayerIdentities(config, process.env)
  return runMultiplayer(config, process.env)
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
