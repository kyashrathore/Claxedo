const LAST_USER_ID_KEY = "claxedo:auth:lastUserId"
const PREFERENCE_PREFIX = "claxedo:"

export function clearPersistedAuthState() {
  for (const key of Object.keys(localStorage)) {
    if (key === LAST_USER_ID_KEY || !key.startsWith(PREFERENCE_PREFIX)) continue
    localStorage.removeItem(key)
  }
}

export function recordAuthIdentity(userId: string | null | undefined) {
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
