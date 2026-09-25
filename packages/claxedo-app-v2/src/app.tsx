import { accountBinding } from "#account-binding"
import type { RunHostedOperation } from "@claxedo/account-contract"
import { createMemo, onCleanup, Show, type JSX, type ParentProps } from "solid-js"
import { AuthProvider, useAuth, type Auth, type AuthState } from "@/auth"
import { I18nProvider } from "@/i18n"
import { ClockProvider } from "@/lib/clock"
import { ProjectListProvider } from "@/projects"
import { CompactSwitcher, MainSidebar } from "@/rail"
import { createServer, ServerProvider, type AuthSource } from "@/server"
import { SessionStoresProvider } from "@/session"
import { AttentionAlerts } from "@/notifications"
import { PreferencesProvider, usePreferences } from "@/settings"
import { AppShell, createShellRegistries, ShellRegistriesContext, ShellRouter, type ShellRouterComponent } from "@/shell"
import { firstParty } from "./registry"
import { DialogProvider, mountSpriteShelf, syncIconLibraryWithTheme, ThemeProvider } from "@/ui"

export type AppProps = { readonly router?: ShellRouterComponent; readonly serverUrl?: string }

function principalOf(state: AuthState): string | undefined {
  return state.kind === "signedIn" ? state.user.id : undefined
}

type ServerAccess = { readonly auth: AuthSource; readonly account?: RunHostedOperation }

function serverAccess(auth: Auth, principal: string | undefined): ServerAccess {
  if (principal === undefined) return { auth: { kind: "none" } }
  const access = auth.controlPlane
  if (access.kind === "port") return { auth: { kind: "none" }, account: access.run }
  return { auth: { kind: "bearer", token: async (options) => (await access.token({ skipCache: options?.fresh })) ?? undefined } }
}

function ServerScope(props: ParentProps<{ readonly access: ServerAccess; readonly serverUrl?: string }>): JSX.Element {
  const server = createServer({ serverUrl: props.serverUrl, ...props.access })
  return (
    <ServerProvider server={server}>
      <SessionStoresProvider>
        <ProjectListProvider>
          <DialogProvider>{props.children}</DialogProvider>
        </ProjectListProvider>
      </SessionStoresProvider>
    </ServerProvider>
  )
}

function Alerts(): JSX.Element {
  const preferences = usePreferences()
  return <AttentionAlerts preferences={preferences.alerts} />
}

function SignedServer(props: ParentProps<{ readonly serverUrl?: string }>): JSX.Element {
  const auth = useAuth()
  const principal = createMemo(() => principalOf(auth.state()))
  return (
    <Show when={{ principal: principal() }} keyed>
      {(scope) => (
        <ServerScope access={serverAccess(auth, scope.principal)} serverUrl={props.serverUrl}>
          {props.children}
        </ServerScope>
      )}
    </Show>
  )
}

export function App(props: AppProps): JSX.Element {
  onCleanup(mountSpriteShelf(document.body))
  const registries = createShellRegistries(firstParty)
  return (
    <AuthProvider binding={accountBinding}>
      <ShellRegistriesContext.Provider value={registries}>
        <I18nProvider>
          <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
            <PreferencesProvider>
              <ClockProvider>
                <ShellRouter router={props.router}>
                  <SignedServer serverUrl={props.serverUrl}>
                    <AppShell mainSidebar={<MainSidebar />} compactTabs={<CompactSwitcher />} />
                    <Alerts />
                  </SignedServer>
                </ShellRouter>
              </ClockProvider>
            </PreferencesProvider>
          </ThemeProvider>
        </I18nProvider>
      </ShellRegistriesContext.Provider>
    </AuthProvider>
  )
}
