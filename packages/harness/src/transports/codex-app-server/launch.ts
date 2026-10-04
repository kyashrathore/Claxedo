import { createKeyedSerializer, errorMessage, stringRecord } from "@claxedo/helpers"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { harnessVersionStanding, type HarnessServices, type StartInput } from "../../contract"
import { CODEX_DEFAULT_PROVIDER, codexProfilePaths, prepareCodexProfile, type CodexProfile } from "../../profiles/codex"
import type { CodexAccountLogin } from "./account"
import type { CodexTransportOptions } from "./entry"
import { CodexTransportError } from "./errors"
import { codexLaunchKey } from "./launch-key"
import { CodexMember } from "./member"
import { CodexProcessPool } from "./pool"
import { CodexRouter } from "./router"
import { CodexRpc, codexRetirementDeadline, type CodexConnection } from "./rpc"
import { CODEX_RANGE, codexReportedVersion } from "./version"

export type CodexProcess = { rpc: CodexRpc; router: CodexRouter; version: string }

export type CodexLaunch = { member: CodexMember; key: string; home: string; modelProvider?: string; plugins: string[]; version: string; release: () => Promise<void> }

async function prepareProfile(input: StartInput, options: CodexTransportOptions, services: HarnessServices): Promise<CodexProfile> {
  const profileInput = { homeRoot: options.homeRoot, credentials: input.credentials, projection: input.projection }
  await services.recordHomeUse(codexProfilePaths(profileInput).store)
  return prepareCodexProfile({ ...profileInput, ownerHome: options.ownerHome })
}

async function startCodexProcess(profile: CodexProfile, options: CodexTransportOptions, services: HarnessServices, signal: AbortSignal): Promise<CodexProcess> {
  const env = { ...stringRecord(options.env ?? process.env), CODEX_HOME: profile.home }
  const overrides = profile.configOverrides.flatMap((override) => ["-c", override])
  const owned = await services.spawn({ file: options.binary, args: ["app-server", ...overrides, "--listen", "stdio://"], cwd: profile.home, env },
    { role: "harness", label: "Codex app-server", home: profile.store, signal })
  const rpc = new CodexRpc(owned, services.clock)
  const router = new CodexRouter(rpc, services.clock, services.log)
  const abandon = () => { void rpc.retire(codexRetirementDeadline(services)).then(undefined, (error: unknown) => services.log.error("Codex app-server retirement failed", { error: errorMessage(error) })) }
  signal.addEventListener("abort", abandon, { once: true })
  if (signal.aborted) abandon()
  try {
    const version = codexReportedVersion(await rpc.request("initialize",
      { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }))
    harnessVersionStanding(CODEX_RANGE, version)
    rpc.notify("initialized")
    return { rpc, router, version: String(version) }
  } catch (error) {
    await rpc.retire(codexRetirementDeadline(services))
    throw error
  } finally { signal.removeEventListener("abort", abandon) }
}

export async function codexModelProvider(launch: { modelProvider?: string; member: CodexConnection }, directory: string): Promise<string> {
  if (launch.modelProvider) return launch.modelProvider
  const read = asRecordOrEmpty(await launch.member.request("config/read", { cwd: directory }))
  return asString(asRecordOrEmpty(read.config).model_provider) ?? CODEX_DEFAULT_PROVIDER
}

export class CodexLaunches {
  private readonly abort = new AbortController()
  private readonly probes = new Set<CodexRpc>()
  private readonly pool: CodexProcessPool
  private readonly firstStarts = createKeyedSerializer()
  private readonly initializedStores = new Set<string>()

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {
    this.pool = new CodexProcessPool(services.clock, services.log, options.idleMs)
  }

  assertLive(stage: string): void {
    if (this.abort.signal.aborted) throw new CodexTransportError("process", `Codex transport disposed${stage}`)
  }

  key(input: StartInput): string { return codexLaunchKey(input, this.options.homeRoot) }

  async join(input: StartInput, account: CodexAccountLogin): Promise<CodexLaunch> {
    this.assertLive("")
    const key = this.key(input)
    const profile = await prepareProfile(input, this.options, this.services)
    const lease = await this.pool.acquire(key, (signal) => this.start(profile, signal))
    const { router, version } = lease.process
    const member = new CodexMember(router, account)
    const release = async () => {
      member.leave()
      await lease.release()
    }
    return { member, key, home: profile.home, ...(profile.modelProvider ? { modelProvider: profile.modelProvider } : {}), plugins: profile.plugins, version, release }
  }

  async probe<T>(input: StartInput, read: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    this.assertLive("")
    const profile = await prepareProfile(input, this.options, this.services)
    const { rpc } = await this.start(profile, this.abort.signal)
    this.probes.add(rpc)
    try { return await read(rpc) }
    finally {
      this.probes.delete(rpc)
      await rpc.retire(codexRetirementDeadline(this.services))
    }
  }

  async dispose(): Promise<void> {
    this.abort.abort()
    for (const rpc of this.probes) await rpc.retire(codexRetirementDeadline(this.services))
    await this.pool.dispose()
  }

  private start(profile: CodexProfile, signal: AbortSignal): Promise<CodexProcess> {
    if (this.initializedStores.has(profile.store)) return startCodexProcess(profile, this.options, this.services, signal)
    return this.firstStarts.run(profile.store, async () => {
      const started = await startCodexProcess(profile, this.options, this.services, signal)
      this.initializedStores.add(profile.store)
      return started
    })
  }
}
