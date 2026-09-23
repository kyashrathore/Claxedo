import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { SessionInventoryRow } from "../query/types"

function isSessionProjectionSourceFamily(value: unknown) {
  return value === "local-control-sessions" ||
    value === "signed-runtime-sessions" ||
    value === "control-plane-sessions"
}

/** Stop reads that can publish a pre-archive row after cache reconciliation. */
export async function cancelArchiveProjectionReads(input: {
  baseUrl?: string
  directory: SessionInventoryRow["directory"]
  sessionId: string
}) {
  const inventoryKey = queryKeys.shell.sessionInventory(input.baseUrl)
  const server = inventoryKey[1]
  const directoryKey = queryKeys.directory.sessionCache(input.directory)

  await queryClient.cancelQueries({
    predicate: (query) => {
      const key = query.queryKey
      if (!Array.isArray(key)) return false
      if (key[0] === "shell" && key[1] === "session" && key[2] === input.sessionId) return true
      if (key[0] === directoryKey[0] && key[1] === directoryKey[1] && key[2] === directoryKey[2] && key[3] === directoryKey[3]) {
        return true
      }
      if (key[0] !== "shell") return false
      if (key[1] === server && (key[2] === "sessionInventory" || key[2] === "sessionList")) return true
      if (isSessionProjectionSourceFamily(key[1])) return key[2] === server
      if (key[1] !== "global-sync") return false
      if (key[2] === "signed-workspace-snapshot") return key[3] === server
      return key[2] === "workspace-groups" && typeof key[3] === "string" && key[3].startsWith(`${server}/`)
    },
  })
}
