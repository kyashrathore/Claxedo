import { useGlobalSync } from "@/context/global-sync"

export type GlobalBootstrapSource = {
  bootstrap: (harnessType?: string) => Promise<unknown> | unknown
}

export async function bootstrapGlobalShellData(input: {
  source: GlobalBootstrapSource
  harnessType?: string
}) {
  return await input.source.bootstrap(input.harnessType)
}

export function useGlobalBootstrapActions() {
  const source = useGlobalSync()
  return {
    bootstrap: (input: { harnessType?: string } = {}) =>
      bootstrapGlobalShellData({
        source,
        harnessType: input.harnessType,
      }),
  }
}
