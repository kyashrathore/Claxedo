import { expiryFromJwt, type ProviderDirect } from "@claxedo/agent-runtime-contract"
import { createKeyedSerializer } from "@claxedo/helpers"
import type { Plugin } from "@opencode-ai/plugin"
import { Integration } from "@opencode-ai/schema/integration"
import type { CredentialRefreshRequest } from "../../contract"
import { TransportError } from "../../contract/errors.js"
import { PLAN_CREDENTIAL_PROVIDER, PLAN_PROVIDER, planAccount, planIdentity } from "./credentials.js"
import { openCodeLocationClient, type OpenCodeHost } from "./host.js"
import { watchPluginEvents } from "./plugin-events.js"

const PLAN_METHOD = Integration.MethodID.make("chatgpt-headless")
const PLAN_PLACEHOLDER = "claxedo-delivered-chatgpt-plan"
const ACCOUNT_HEADER = "chatgpt-account-id"
const PLAN_TAKEN_MS = 10_000
const RENEW_BEFORE_MS = 10 * 60 * 1000

export type PlanRenewalSource = Readonly<{
  refresh(request: CredentialRefreshRequest): Promise<ProviderDirect | undefined>
  sessions(): readonly string[]
}>
type HttpRequest = { request: Request }
type HttpResponse = { sessionID: string; request: Request; response: Response }
type Retry = { sessionID: string; error: { status?: number }; decision: { retry: false } | { retry: true; delay: number } }
type HeldPlan = Readonly<{ credentialId: string; accountID: string; access: string; expires: number }>

function planOf(row: ProviderDirect, credentialId = planIdentity(row)): HeldPlan {
  const accountID = planAccount(row)
  if (!accountID) throw new TransportError("opencode", "credential_unavailable", "The ChatGPT plan's token names no account")
  return { credentialId, accountID, access: row.secret, expires: expiryFromJwt(row.secret) ?? row.expiresAt ?? Number.MAX_SAFE_INTEGER }
}

async function accountTaken(context: Plugin.Context, accountID: string | undefined): Promise<void> {
  const holds = async () => (await context.catalog.provider.get({ providerID: PLAN_PROVIDER })).data?.headers?.[ACCOUNT_HEADER] === accountID
  const taken = Promise.withResolvers<void>()
  const watch = watchPluginEvents(context, (type) => type === "catalog.updated", async () => { if (await holds()) taken.resolve() },
    "OpenCode ChatGPT plan watch failed")
  const timer = setTimeout(() => taken.reject(new TransportError("opencode", "engine", "OpenCode did not take the ChatGPT plan")), PLAN_TAKEN_MS)
  try {
    if (await holds()) taken.resolve()
    await taken.promise
  } finally {
    clearTimeout(timer)
    await watch.close()
  }
}

class ChatGptPlanLogin {
  private held?: HeldPlan
  private unrenewable?: string
  private readonly locations = new Set<Plugin.Context>()
  private readonly renewed = new Set<string>()
  private readonly serial = createKeyedSerializer()

  constructor(private readonly host: () => OpenCodeHost, private readonly source: PlanRenewalSource) {}

  readonly plugin: Plugin.Plugin = { id: "claxedo-chatgpt-plan", setup: (context) => this.setup(context) }

  private async setup(context: Plugin.Context): Promise<() => void> {
    await context.integration.transform((draft) => draft.method.update({ integrationID: PLAN_PROVIDER,
      method: { id: PLAN_METHOD, type: "oauth", label: "ChatGPT plan delivered by Claxedo" },
      authorize: async () => ({ mode: "code", url: "", instructions: "", callback: async () => this.connection() }) }))
    await context.session.hook("http.request", (event) => this.authorize(event), { providerID: PLAN_PROVIDER })
    await context.session.hook("http.response", (event) => this.refused(event), { providerID: PLAN_PROVIDER })
    await context.session.hook("retry", (event) => this.retry(event), { providerID: PLAN_PROVIDER })
    this.locations.add(context)
    return () => { this.locations.delete(context) }
  }

  offer(row: ProviderDirect | undefined, directory: string): Promise<void> {
    return this.serial.run("install", async () => {
      const next = row && planOf(row)
      const held = this.held
      if (!next || held?.credentialId !== next.credentialId || held.accountID !== next.accountID) return this.switchTo(next, directory)
      if (next.expires > held.expires) this.held = next
    })
  }

  private connection() {
    return { type: "oauth" as const, methodID: PLAN_METHOD, access: PLAN_PLACEHOLDER, refresh: "", expires: Number.MAX_SAFE_INTEGER,
      metadata: { accountID: this.held?.accountID } }
  }

  private async switchTo(plan: HeldPlan | undefined, directory: string): Promise<void> {
    const client = await openCodeLocationClient(this.host(), directory)
    const location = { directory }
    const previous = ((await client.integration.get({ location, integrationID: PLAN_PROVIDER })).data?.connections ?? [])
      .flatMap((connection) => connection.type === "credential" ? [connection.id] : [])
    this.held = plan
    if (!plan && !previous.length) return
    if (plan) {
      try {
        const attempt = await client.integration.oauth.connect({ location, integrationID: PLAN_PROVIDER, methodID: PLAN_METHOD })
        await client.integration.oauth.complete({ location, integrationID: PLAN_PROVIDER, attemptID: attempt.data.attemptID, code: "claxedo" })
      } catch (error) {
        this.held = undefined
        throw error
      }
    }
    for (const credentialID of previous) await client.credential.remove({ location, credentialID })
    await Promise.all([...this.locations].map((context) => accountTaken(context, plan?.accountID)))
  }

  private renewFrom(rejected: HeldPlan): Promise<HeldPlan | undefined> {
    return this.serial.run("renew", async () => {
      const held = this.held
      if (!held || held.access !== rejected.access) return held
      let row: ProviderDirect | undefined
      for (const sessionId of this.source.sessions()) {
        row ??= await this.source.refresh({ sessionId, credentialProviderId: PLAN_CREDENTIAL_PROVIDER, rejectedExpiresAt: rejected.expires })
      }
      if (row?.authKind !== "subscription" || row.secret === rejected.access) {
        this.unrenewable = rejected.access
        return undefined
      }
      return this.held = planOf(row, held.credentialId)
    })
  }

  private async authorize(event: HttpRequest): Promise<void> {
    const held = this.held
    if (!held) return
    const due = held.expires - Date.now() < RENEW_BEFORE_MS && held.access !== this.unrenewable
    const current = due ? (await this.renewFrom(held)) ?? held : held
    event.request.headers.set("authorization", `Bearer ${current.access}`)
  }

  private async refused(event: HttpResponse): Promise<void> {
    const held = this.held
    if (event.response.status !== 401 || !held) return
    const renewed = event.request.headers.get("authorization") === `Bearer ${held.access}` ? await this.renewFrom(held) : held
    if (renewed) this.renewed.add(event.sessionID)
  }

  private retry(event: Retry): void {
    if (event.error.status === 401 && this.renewed.delete(event.sessionID)) event.decision = { retry: true, delay: 0 }
  }
}

export type OpenCodePlanLogin = Pick<ChatGptPlanLogin, "plugin" | "offer">

export function createPlanLogin(host: () => OpenCodeHost, source: PlanRenewalSource): OpenCodePlanLogin {
  return new ChatGptPlanLogin(host, source)
}
