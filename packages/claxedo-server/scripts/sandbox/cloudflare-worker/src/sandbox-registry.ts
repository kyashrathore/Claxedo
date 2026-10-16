// Structural, like every binding this Worker reads, so the Worker's own build
// needs no @cloudflare/workers-types global scope.
interface RegistryR2Object {
  key: string
  customMetadata?: Record<string, string>
}

export interface RegistryR2 {
  put(key: string, value: string | null, options?: { customMetadata?: Record<string, string> }): Promise<unknown>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    cursor?: string
    limit?: number
    include?: ("customMetadata" | "httpMetadata")[]
  }): Promise<{ objects: RegistryR2Object[]; truncated: boolean; cursor?: string }>
}

const REGISTRY_PREFIX = "sandbox-registry/"
const REGISTRY_LIST_PAGE = 1_000
const REGISTRY_LABELS = ["app", "workspaceId", "epoch", "homeRegion"]
const REGISTRY_LABEL_MAX = 256

function registryKey(sandboxId: string) {
  return `${REGISTRY_PREFIX}${sandboxId}`
}

/**
 * Records a sandbox the control plane's GC may need to find: a Durable Object
 * namespace cannot be enumerated (`idFromName` is one-way), so this registry
 * is the only inventory. Labels live in `customMetadata`, one LIST per page,
 * and only the ones GC reads are kept, each bounded, because metadata is
 * capped near 2 KB and one oversized label must not leave a sandbox
 * unregistered. A failed write is logged, never fatal to the start.
 */
export async function registerSandbox(bucket: RegistryR2 | undefined, sandboxId: string, labels: Record<string, string>) {
  if (!bucket) return
  const customMetadata: Record<string, string> = { sandboxId }
  for (const key of REGISTRY_LABELS) {
    const value = labels[key]
    if (typeof value === "string" && value.length <= REGISTRY_LABEL_MAX) customMetadata[key] = value
  }
  await bucket.put(registryKey(sandboxId), null, { customMetadata }).catch((error: unknown) => {
    console.error("sandbox registry write failed", { sandboxId, error: String(error) })
  })
}

/** A leaked record is a sweep reporting a sandbox that is gone, which the next idempotent destroy clears. */
export async function unregisterSandbox(bucket: RegistryR2 | undefined, sandboxId: string) {
  if (!bucket) return
  await bucket.delete(registryKey(sandboxId)).catch((error: unknown) => {
    console.error("sandbox registry delete failed", { sandboxId, error: String(error) })
  })
}

export async function listSandboxes(bucket: RegistryR2) {
  const sandboxes: Array<Record<string, string>> = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({
      prefix: REGISTRY_PREFIX,
      limit: REGISTRY_LIST_PAGE,
      include: ["customMetadata"],
      ...(cursor ? { cursor } : {}),
    })
    for (const object of page.objects) {
      const metadata = object.customMetadata ?? {}
      const sandboxId = metadata.sandboxId ?? object.key.slice(REGISTRY_PREFIX.length)
      if (sandboxId) sandboxes.push({ ...metadata, sandboxId })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return sandboxes
}
