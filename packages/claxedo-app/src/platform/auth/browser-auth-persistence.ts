import { isProjectionCacheKey } from "@/platform/persistence/keys"

const LAST_USER_ID_KEY = "opencode.auth.lastUserId"

export function clearPersistedAuthState() {
  for (const key of Object.keys(localStorage)) {
    if (key === LAST_USER_ID_KEY) continue
    if (!key.startsWith("opencode.") && !isProjectionCacheKey(key)) continue
    localStorage.removeItem(key)
  }
}

export function recordBrowserAuthIdentity(userId: string | null | undefined) {
  if (!userId) return
  let previous: string | null = null
  try {
    previous = localStorage.getItem(LAST_USER_ID_KEY)
  } catch {
    return
  }
  if (previous && previous !== userId) clearPersistedAuthState()
  if (previous !== userId) localStorage.setItem(LAST_USER_ID_KEY, userId)
}
