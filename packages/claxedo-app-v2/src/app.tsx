import { browserAuthAdapter } from "#browser-auth-adapter"
import { createMemo, Show, type JSX, type ParentProps } from "solid-js"
import { AccessProvider } from "@/access"
import { AuthProvider, useAuth, type Auth, type AuthState } from "@/auth"
import { I18nProvider } from "@/i18n"
import { MainSidebar } from "@/rail"
import { createServer, ServerProvider, type AuthSource } from "@/server"
import { SessionStoresProvider } from "@/session"
import { AppShell, createShellRegistries, ShellRegistriesContext, ShellRouter, type ShellRouterComponent } from "@/shell"
import { firstParty } from "@/shell/registry"
import { DialogProvider, ThemeProvider } from "@/ui"

export type AppProps = { readonly router?: ShellRouterComponent }

function principalOf(state: AuthState): string | undefined {
  return state.kind === "signedIn" ? state.user.id : undefined
}

function authSource(auth: Auth, principal: string | undefined): AuthSource {
  if (principal === undefined) return { kind: "none" }
  return { kind: "bearer", token: async (options) => (await auth.token({ skipCache: options?.fresh })) ?? undefined }
}

function ServerScope(props: ParentProps<{ readonly auth: AuthSource }>): JSX.Element {
  const server = createServer({ auth: props.auth })
  return (
    <ServerProvider server={server}>
      <AccessProvider>
        <SessionStoresProvider>
          <DialogProvider>{props.children}</DialogProvider>
        </SessionStoresProvider>
      </AccessProvider>
    </ServerProvider>
  )
}

function SignedServer(props: ParentProps): JSX.Element {
  const auth = useAuth()
  const principal = createMemo(() => principalOf(auth.state()))
  return (
    <Show when={{ principal: principal() }} keyed>
      {(scope) => <ServerScope auth={authSource(auth, scope.principal)}>{props.children}</ServerScope>}
    </Show>
  )
}

export function App(props: AppProps): JSX.Element {
  const registries = createShellRegistries(firstParty)
  return (
    <AuthProvider adapter={browserAuthAdapter}>
      <ShellRegistriesContext.Provider value={registries}>
        <I18nProvider>
          <ThemeProvider>
            <ShellRouter router={props.router}>
              <SignedServer>
                <AppShell mainSidebar={<MainSidebar />} />
              </SignedServer>
            </ShellRouter>
          </ThemeProvider>
        </I18nProvider>
      </ShellRegistriesContext.Provider>
    </AuthProvider>
  )
}
