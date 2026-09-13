import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { piAgentDir } from "./agent-dir"
import { createPiRpcDriver, type PiDriverOptions } from "./driver"

export type PiAdapterOptions =
  & Omit<SdkRuntimeAdapterOptions, "driver">
  & Omit<PiDriverOptions, "agentDir">
  & { agentDir?: string }
export class PiHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: PiAdapterOptions) {
    super({ ...options, driver: (host) => createPiRpcDriver(host, { ...options, agentDir: piAgentDir(options) }) })
  }
}
