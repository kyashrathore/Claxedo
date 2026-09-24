import type { Disposer } from "@/shell"

export class PluginClaimError extends Error {
  constructor(readonly pluginId: string, readonly key: string, readonly owner: string) {
    super(`${pluginId} cannot register ${key}: it belongs to ${owner}`)
    this.name = "PluginClaimError"
  }
}

export type Claims = { readonly claim: (key: string, pluginId: string) => Disposer }

export function createClaims(): Claims {
  const owners = new Map<string, { readonly pluginId: string; readonly count: number }>()
  const release = (key: string) => {
    const owner = owners.get(key)
    if (!owner) return
    if (owner.count <= 1) owners.delete(key)
    else owners.set(key, { pluginId: owner.pluginId, count: owner.count - 1 })
  }
  return {
    claim: (key, pluginId) => {
      const owner = owners.get(key)
      if (owner && owner.pluginId !== pluginId) throw new PluginClaimError(pluginId, key, owner.pluginId)
      owners.set(key, { pluginId, count: (owner?.count ?? 0) + 1 })
      let released = false
      return () => {
        if (released) return
        released = true
        release(key)
      }
    },
  }
}
