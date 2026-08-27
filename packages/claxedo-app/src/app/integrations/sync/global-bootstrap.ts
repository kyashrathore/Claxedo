import { useGlobalSync } from "@/app/providers/global-sync/provider"

export type GlobalBootstrapSource = {
  bootstrap: (harnessType?: string, opts?: { force?: boolean }) => Promise<unknown> | unknown
}

export async function bootstrapGlobalShellData(input: {
  source: GlobalBootstrapSource
  harnessType?: string
  force?: boolean
}) {
  return await input.source.bootstrap(input.harnessType, { force: input.force })
}

export function useGlobalBootstrapActions() {
  const source = useGlobalSync()
  return {
    bootstrap: (input: { harnessType?: string; force?: boolean } = {}) =>
      bootstrapGlobalShellData({
        source,
        harnessType: input.harnessType,
        force: input.force,
      }),
  }
}
