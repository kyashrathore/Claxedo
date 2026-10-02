import { prefixedRandomId } from "@claxedo/helpers"
import type { PromptModel } from "@claxedo/agent-runtime-contract"
import { type DraftLaunch, type StartInput } from "../../contract"
import { draftProbeKey, DraftProbeCache } from "../../contract/probe-cache"
import { piProbeInputs, selectPiProfile } from "../../profiles/pi"
import { piCommands } from "./title"
import { piCatalog, type PiCatalog } from "./config"
import { launchPiProbe, type PiLaunchHost } from "./launch"
import type { PiRpc } from "./rpc"

export class PiDraftProbes {
  private readonly catalogs = new DraftProbeCache<PiCatalog>()

  constructor(private readonly host: PiLaunchHost) {}

  async catalog(draft: DraftLaunch, model: PromptModel | undefined, mode: "probe" | "peek"): Promise<PiCatalog> {
    const key = draftProbeKey(draft, model?.modelID)
    const inputs = { files: await piProbeInputs(selectPiProfile(draft.credentials, draft.directory, "probe", this.host.options), draft.directory) }
    if (mode === "peek") return await this.catalogs.peek(key, inputs) ?? { models: [], efforts: [] }
    return this.catalogs.read(key, inputs, () => this.probe(draft, model, (rpc) => piCatalog(rpc, model)))
  }

  commands(draft: DraftLaunch) {
    return this.probe(draft, undefined, piCommands)
  }

  private async probe<T>(draft: DraftLaunch, model: PromptModel | undefined, read: (rpc: PiRpc) => Promise<T>): Promise<T> {
    const input: StartInput = { ...draft, sessionId: prefixedRandomId("probe", "-"), ...(model ? { model } : {}) }
    const profile = selectPiProfile(input.credentials, input.directory, input.sessionId, this.host.options)
    const rpc = await launchPiProbe(this.host, input, profile)
    try { return await read(rpc) }
    finally { await this.host.unsettled.retire(rpc) }
  }
}
