import { SdkRuntimeAdapter, type SdkRuntimeAdapterOptions } from "../shared/sdk-runtime-adapter"
import { createCodexAppServerDriver } from "./driver"
import type { FetchLike } from "../../adapter-contract"

export type CodexHarnessAdapterOptions = Omit<SdkRuntimeAdapterOptions, "driver"> & {
  fetch?: FetchLike
  codexHome?: string
  brokeredHome?: string
}

export class CodexHarnessAdapter extends SdkRuntimeAdapter {
  constructor(options: CodexHarnessAdapterOptions) {
    super({
      ...options,
      driver: (host) => createCodexAppServerDriver(host, {
        ...(options.binary ? { binary: options.binary } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.codexHome ? { codexHome: options.codexHome } : {}),
        ...(options.brokeredHome ? { brokeredHome: options.brokeredHome } : {}),
      }),
    })
  }
}
