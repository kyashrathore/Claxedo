import { stringRecord } from "@claxedo/helpers"
import { harnessVersionStanding, type HarnessServices, type StartInput } from "../../contract"
import { codexProfileHome, prepareCodexProfile } from "../../profiles/codex"
import type { CodexTransportOptions } from "./entry"
import { CodexTransportError } from "./errors"
import { CodexRpc, codexRetirementDeadline } from "./rpc"
import { CODEX_RANGE, codexReportedVersion } from "./version"

export type CodexLaunch = { rpc: CodexRpc; home: string; brokered: boolean; plugins: string[]; version: string }

async function spawnCodexProfile(input: StartInput, options: CodexTransportOptions, services: HarnessServices, signal: AbortSignal) {
  const profileInput = { homeRoot: options.homeRoot, credentials: input.credentials, projection: input.projection }
  await services.recordHomeUse(codexProfileHome(profileInput))
  const profile = await prepareCodexProfile({ ...profileInput, ownerHome: options.ownerHome })
  const env = { ...stringRecord(options.env ?? process.env), CODEX_HOME: profile.home }
  const owned = await services.spawn({ file: options.binary, args: ["app-server", "--listen", "stdio://"], cwd: input.directory, env },
    { role: "harness", label: "Codex app-server", sessionId: input.sessionId, home: profile.home, signal })
  return { rpc: new CodexRpc(owned, services.clock), profile }
}

export class CodexLaunches {
  private readonly starting = new Set<CodexRpc>()
  private readonly abort = new AbortController()

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {}

  assertLive(stage: string): void {
    if (this.abort.signal.aborted) throw new CodexTransportError("process", `Codex transport disposed${stage}`)
  }

  async launch(input: StartInput): Promise<CodexLaunch> {
    this.assertLive("")
    const { rpc, profile } = await spawnCodexProfile(input, this.options, this.services, this.abort.signal)
    this.starting.add(rpc)
    try {
      this.assertLive(" during startup")
      const version = codexReportedVersion(await rpc.request("initialize",
        { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }))
      harnessVersionStanding(CODEX_RANGE, version)
      this.assertLive(" during initialize")
      rpc.notify("initialized")
      return { rpc, ...profile, version: String(version) }
    } catch (error) {
      await this.discard(rpc)
      throw error
    }
  }

  settled(rpc: CodexRpc): void { this.starting.delete(rpc) }

  async discard(rpc: CodexRpc): Promise<void> {
    this.starting.delete(rpc)
    await rpc.retire(codexRetirementDeadline(this.services))
  }

  async dispose(): Promise<void> {
    this.abort.abort()
    for (const rpc of this.starting) await rpc.retire(codexRetirementDeadline(this.services))
  }
}
