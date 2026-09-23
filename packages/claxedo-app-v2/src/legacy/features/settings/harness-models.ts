import { useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { loadHarnessModelOptions, useShellQueryOptions } from "@/features/settings/app-ports"
import { harnessSelectionKey, type HarnessSelection } from "@/platform/identity/harness-selection"

/** The models a harness reports for one workspace, for the harnesses that own their own model list. */
export function useHarnessModelOptions(input: {
  serverUrl: Accessor<string>
  directory: Accessor<string | undefined>
  harness: Accessor<HarnessSelection | undefined>
  enabled: Accessor<boolean>
}) {
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  return useQuery(() => {
    const harness = input.harness()
    const directory = input.directory()
    return {
      queryKey: ["settings", "harness-models", input.serverUrl(), directory ?? "", harness ? harnessSelectionKey(harness) : ""],
      enabled: input.enabled() && !!directory && !!harness,
      staleTime: 60_000,
      queryFn: () => loadHarnessModelOptions({
        serverUrl: input.serverUrl(),
        scope: { directory },
        harness: harness!,
        projects: () => projects.data ?? [],
      }),
    }
  })
}
