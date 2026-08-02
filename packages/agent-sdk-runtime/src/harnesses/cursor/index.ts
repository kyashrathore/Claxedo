import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { createCursorSdkDriver } from "./driver"

export type CursorHarnessAdapterOptions = Omit<SdkRuntimeAdapterOptions, "driver">

export class CursorHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: CursorHarnessAdapterOptions) {
    super({ ...options, driver: createCursorSdkDriver })
  }
}
