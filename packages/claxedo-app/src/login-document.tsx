import { accountBinding } from "#account-binding"
import type { JSX } from "solid-js"
import { AuthProvider, LoginForm, type LoginHost } from "@/auth"
import { PreferencesProvider } from "@/settings"
import { codexTheme, syncIconLibraryWithTheme, ThemeProvider } from "@/ui"

const LOGIN_PATH = "/login"

function documentLoginHost(): LoginHost {
  if (window.location.pathname !== LOGIN_PATH) window.history.replaceState(null, "", LOGIN_PATH)
  const location = { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }
  return { location: () => location, replaceWith: (path) => window.location.replace(path) }
}

export function LoginDocument(): JSX.Element {
  return (
    <AuthProvider binding={accountBinding}>
      <ThemeProvider defaultTheme={codexTheme} onThemeApplied={syncIconLibraryWithTheme}>
        <PreferencesProvider>
          <LoginForm host={documentLoginHost()} />
        </PreferencesProvider>
      </ThemeProvider>
    </AuthProvider>
  )
}
