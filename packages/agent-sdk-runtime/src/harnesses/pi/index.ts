import path from "node:path"
import { trimToUndefined } from "@claxedo/helpers/string"
import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { createPiRpcDriver, type PiDriverOptions } from "./driver"

export type PiAdapterOptions = Omit<SdkRuntimeAdapterOptions, "driver"> & PiDriverOptions
export class PiHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: PiAdapterOptions) {
    const agentDir = options.agentDir ?? (options.storeRoot ? path.join(options.storeRoot, "pi", "agent") : undefined)
      ?? trimToUndefined(process.env.PI_CODING_AGENT_DIR)
    super({ ...options, driver: (host) => createPiRpcDriver(host, { ...options, agentDir }) })
  }
}
