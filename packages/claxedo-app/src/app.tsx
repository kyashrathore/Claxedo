import { accountBinding } from "#account-binding"
import { createMemo, onCleanup, Show, type JSX, type ParentProps } from "solid-js"
import { AuthProvider, useAuth, type Auth } from "@/auth"
import { I18nProvider, useI18n } from "@/i18n"
import { ClockProvider } from "@/lib/clock"
import { tabStorage } from "@/lib/persisted"
import { ProjectListProvider } from "@/projects"
import { CompactSwitcher, MainSidebar } from "@/rail"
import { createServer, ServerProvider, type ServerConfig } from "@/server"
import { SessionStoresProvider } from "@/session"
import { AttentionAlerts } from "@/notifications"
import { PreferencesProvider, usePreferences } from "@/settings"
import { AppShell, createShellRegistries, ShellRegistriesContext, ShellRouter, type ShellRouterComponent } from "@/shell"
import { firstParty, firstPartyDictionaries } from "./registry"
import { DialogProvider, syncIconLibraryWithTheme, ThemeProvider } from "@/ui"

export type AppProps = { readonly router?: ShellRouterComponent; readonly serverUrl?: string }

function principalOf(auth: Auth): string | undefined {
  const state = auth.state()
  return state.kind === "signedIn" ? state.user.id : auth.restoringUserId()
}

type ServerAccess = Pick<ServerConfig, "account" | "accountEvents" | "cookies" | "onSignInRefused" | "relayLinks">

function relayLinks(principal: string): Pick<ServerConfig, "relayLinks"> {
  const storage = tabStorage()
  if (!storage) return {}
  const siblings = typeof BroadcastChannel === "function" ? new BroadcastChannel(`claxedo:relay-links:${principal}`) : undefined
  if (siblings) onCleanup(() => siblings.close())
  return { relayLinks: { scope: principal, storage, ...(siblings ? { siblings } : {}) } }
}

function serverAccess(auth: Auth, principal: string | undefined): ServerAccess {
  if (principal === undefined) return {}
  const access = auth.controlPlane
  if (access.kind === "port") return { account: access.run, accountEvents: access.events, ...relayLinks(principal) }
  return { cookies: true, onSignInRefused: () => void auth.refresh(), ...relayLinks(principal) }
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

function Alerts(props: ParentProps): JSX.Element {
  const preferences = usePreferences()
  return <AttentionAlerts preferences={preferences.alerts}>{props.children}</AttentionAlerts>
}

function LocaleReady(props: ParentProps): JSX.Element {
  const i18n = useI18n()
  return <Show when={i18n.ready()}>{props.children}</Show>
}

function SignedServer(props: ParentProps<{ readonly serverUrl?: string }>): JSX.Element {
  const auth = useAuth()
  const principal = createMemo(() => principalOf(auth))
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
  const registries = createShellRegistries(firstParty)
  return (
    <AuthProvider binding={accountBinding}>
      <ShellRegistriesContext.Provider value={registries}>
        <I18nProvider dictionaries={firstPartyDictionaries}>
          <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
            <PreferencesProvider>
              <ClockProvider>
                <ShellRouter router={props.router}>
                  <SignedServer serverUrl={props.serverUrl}>
                    <LocaleReady>
                      <Alerts>
                        <AppShell mainSidebar={<MainSidebar />} compactTabs={<CompactSwitcher />} />
                      </Alerts>
                    </LocaleReady>
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
