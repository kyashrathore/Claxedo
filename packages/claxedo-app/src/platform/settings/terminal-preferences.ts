const SCREEN_READER_MODE_KEY = "claxedo.terminal.screen-reader-mode"

export function getScreenReaderModePreference() {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(SCREEN_READER_MODE_KEY) === "1"
  } catch {
    return false
  }
}

export function setScreenReaderModePreference(enabled: boolean) {
  if (typeof localStorage === "undefined") return
  try {
    if (enabled) localStorage.setItem(SCREEN_READER_MODE_KEY, "1")
    else localStorage.removeItem(SCREEN_READER_MODE_KEY)
  } catch {
    // Storage is best-effort when browser persistence is unavailable.
  }
}
