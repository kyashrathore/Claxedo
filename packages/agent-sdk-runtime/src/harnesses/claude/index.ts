import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { createClaudeSdkDriver } from "./driver"

export type ClaudeHarnessAdapterOptions = Omit<SdkRuntimeAdapterOptions, "driver">

export class ClaudeHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: ClaudeHarnessAdapterOptions) {
    super({ ...options, driver: createClaudeSdkDriver })
  }
}
