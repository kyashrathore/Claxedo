const LAST_USER_ID_KEY = "claxedo:auth:lastUserId"
const PREFERENCE_PREFIX = "claxedo:"

export function clearPersistedAuthState() {
  for (const key of Object.keys(localStorage)) {
    if (key === LAST_USER_ID_KEY || !key.startsWith(PREFERENCE_PREFIX)) continue
    localStorage.removeItem(key)
  }
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(PREFERENCE_PREFIX)) sessionStorage.removeItem(key)
  }
}

export function recordAuthIdentity(userId: string | null | undefined) {
  if (!userId) return
  let previous: string | null = null
  try {
    previous = localStorage.getItem(LAST_USER_ID_KEY)
  } catch (error) {
    console.warn("The last signed-in user could not be read, so this sign-in keeps the stored preferences", { error })
    return
  }
  if (previous && previous !== userId) clearPersistedAuthState()
  if (previous !== userId) localStorage.setItem(LAST_USER_ID_KEY, userId)
}

export function lastAuthIdentity(): string | undefined {
  try {
    return localStorage.getItem(LAST_USER_ID_KEY) ?? undefined
  } catch (error) {
    console.warn("The last signed-in user could not be read, so startup waits for the session before reading the account", { error })
    return undefined
  }
}
