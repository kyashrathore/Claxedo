export type LaunchedPluginRoot = { pluginInstanceId: string; root: string; dataRoot: string; skillNames: readonly string[] }

export function pluginRoots(launch: Record<string, Record<string, unknown>>, harnessId: string): LaunchedPluginRoot[] {
  return (launch[harnessId]?.pluginRoots ?? []) as LaunchedPluginRoot[]
}
