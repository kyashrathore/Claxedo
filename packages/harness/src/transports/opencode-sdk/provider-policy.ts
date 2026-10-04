import type { Plugin } from "@opencode-ai/plugin"
import { createKeyedSerializer } from "@claxedo/helpers"
import { openCodeLocationClient, type OpenCodeHost } from "./host.js"
import type { WorkspaceScope } from "./scope.js"
import { asArrayOrUndefined as arr } from "@claxedo/helpers/guards"

export type ProviderConfigStore = {

  read(): Promise<Record<string, unknown>>

  write(patch: { disabled_providers: string[] }): Promise<Record<string, unknown>>
}

type DirectoryPolicy = { disabled: string[]; catalogs: Set<() => Promise<void>>; store: ProviderConfigStore }

async function readDisabled(context: Plugin.Context, key: string): Promise<string[]> {
  const raw = await context.storage.get(key)
  const saved = arr(raw)
  if (raw !== undefined && !saved?.every((id) => typeof id === "string")) {
    throw new Error("Invalid persisted OpenCode provider policy")
  }
  return saved?.filter((id): id is string => typeof id === "string") ?? []
}

function directoryPolicy(context: Plugin.Context, key: string, disabled: string[]): DirectoryPolicy {
  const serializer = createKeyedSerializer()
  const policy: DirectoryPolicy = { disabled, catalogs: new Set(), store: {
    read: () => serializer.run(key, async () => ({ disabled_providers: [...policy.disabled] })),
    write(patch) {
      const next = [...new Set(patch.disabled_providers)]
      return serializer.run(key, async () => {
        await context.storage.set(key, next)
        policy.disabled = next
        await Promise.all([...policy.catalogs].map((reload) => reload()))
        return { disabled_providers: [...policy.disabled] }
      })
    },
  } }
  return policy
}

async function setupProviderPolicy(context: Plugin.Context, policies: Map<string, DirectoryPolicy>) {
  const directory = context.location.directory
  const key = `disabled-providers:${directory}`
  const policy = policies.get(directory) ?? directoryPolicy(context, key, await readDisabled(context, key))
  policies.set(directory, policy)
  await context.catalog.transform((draft) => {
    for (const id of policy.disabled) draft.provider.update(id, (provider) => { provider.activation = "disabled" })
  })
  const reload = () => context.catalog.reload()
  policy.catalogs.add(reload)
  return () => { policy.catalogs.delete(reload) }
}

export function createProviderPolicy() {
  const policies = new Map<string, DirectoryPolicy>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-policy",
    setup: (context) => setupProviderPolicy(context, policies),
  }
  return {
    plugin,
    async store(host: OpenCodeHost, scope: WorkspaceScope): Promise<ProviderConfigStore> {
      await openCodeLocationClient(host, scope.directory)
      const policy = policies.get(scope.directory)
      if (!policy) throw new Error("OpenCode provider policy was not initialized for the workspace")
      return policy.store
    },
  }
}
