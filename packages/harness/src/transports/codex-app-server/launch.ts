import { errorMessage, stringRecord } from "@claxedo/helpers"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { harnessVersionStanding, type HarnessServices, type StartInput } from "../../contract"
import { CODEX_BROKER_PROVIDER, CODEX_DEFAULT_PROVIDER, codexProfilePaths, prepareCodexProfile, type CodexProfile } from "../../profiles/codex"
import type { CodexTransportOptions } from "./entry"
import { CodexTransportError } from "./errors"
import { codexLaunchKey } from "./launch-key"
import { CodexMember } from "./member"
import type { CodexLease } from "./pool"
import { CodexRouter } from "./router"
import { CodexRpc, codexRetirementDeadline, type CodexConnection } from "./rpc"
import { CODEX_RANGE, codexReportedVersion } from "./version"

export type CodexProcess = { rpc: CodexRpc; router: CodexRouter; home: string; brokered: boolean; plugins: string[]; version: string }

export type CodexLaunch = { member: CodexMember; key: string; home: string; brokered: boolean; plugins: string[]; version: string; release: () => Promise<void> }

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
  try {
    const version = codexReportedVersion(await rpc.request("initialize",
      { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }))
    harnessVersionStanding(CODEX_RANGE, version)
    rpc.notify("initialized")
    return { rpc, router, home: profile.home, brokered: profile.brokered, plugins: profile.plugins, version: String(version) }
  } catch (error) {
    await rpc.retire(codexRetirementDeadline(services))
    throw error
  } finally { signal.removeEventListener("abort", abandon) }
}

export async function codexModelProvider(launch: { brokered: boolean; member: CodexConnection }, directory: string): Promise<string> {
  if (launch.brokered) return CODEX_BROKER_PROVIDER
  const read = asRecordOrEmpty(await launch.member.request("config/read", { cwd: directory }))
  return asString(asRecordOrEmpty(read.config).model_provider) ?? CODEX_DEFAULT_PROVIDER
}

export class CodexLaunches {
  private readonly abort = new AbortController()
  private readonly probes = new Set<CodexRpc>()

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {}

  assertLive(stage: string): void {
    if (this.abort.signal.aborted) throw new CodexTransportError("process", `Codex transport disposed${stage}`)
  }

  key(input: StartInput): string { return codexLaunchKey(input, this.options) }

  async join(input: StartInput, apiKey: () => string | undefined): Promise<CodexLaunch> {
    this.assertLive("")
    const key = this.key(input)
    const profile = await prepareProfile(input, this.options, this.services)
    const lease = await this.untilDisposed(this.options.pool.acquire(key, (signal) => startCodexProcess(profile, this.options, this.services, signal)))
    const { router, version } = lease.process
    const member = new CodexMember(router, apiKey)
    const release = async () => {
      member.leave()
      await lease.release()
    }
    return { member, key, home: profile.home, brokered: profile.brokered, plugins: profile.plugins, version, release }
  }

  async probe<T>(input: StartInput, read: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    this.assertLive("")
    const profile = await prepareProfile(input, this.options, this.services)
    const { rpc } = await startCodexProcess(profile, this.options, this.services, this.abort.signal)
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
  }

  private async untilDisposed(pending: Promise<CodexLease<CodexProcess>>): Promise<CodexLease<CodexProcess>> {
    const disposed = Promise.withResolvers<never>()
    const abort = () => disposed.reject(new CodexTransportError("process", "Codex transport disposed during startup"))
    this.abort.signal.addEventListener("abort", abort, { once: true })
    try { return await Promise.race([pending, disposed.promise]) }
    catch (error) {
      void pending.then((lease) => lease.release(), (cause: unknown) => this.services.log.debug("Codex app-server startup failed after its transport left", { error: errorMessage(cause) }))
      throw error
    } finally { this.abort.signal.removeEventListener("abort", abort) }
  }
}
