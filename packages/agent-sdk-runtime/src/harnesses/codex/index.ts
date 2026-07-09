import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { createCodexAppServerDriver } from "./driver"

export type CodexHarnessAdapterOptions = Omit<SdkRuntimeAdapterOptions, "driver"> & {
  fetch?: typeof fetch
  codexHome?: string
}

export class CodexHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: CodexHarnessAdapterOptions) {
    super({ ...options, driver: (host) => createCodexAppServerDriver(host, { binary: options.binary, fetch: options.fetch, codexHome: options.codexHome }) })
  }
}
