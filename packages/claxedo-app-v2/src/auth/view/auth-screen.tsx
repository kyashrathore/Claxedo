import { createResource, Match, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createBrowserAuthAdapter } from "#browser-auth-adapter"
import type { PageProps } from "@/shell"
import { useElapsed } from "@/lib/delay"
import { AuthProvider } from "../provider"
import { startBrowserAuth } from "../store"
import "./auth.css"

export function AuthScreen(props: { readonly page: () => JSX.Element }): JSX.Element {
  const adapter = createBrowserAuthAdapter()
  const [started] = createResource(() => startBrowserAuth(adapter))
  const elapsed = useElapsed()
  return (
    <Switch>
      <Match when={started.state === "ready"}>
        <AuthProvider adapter={adapter}>
          <Dynamic component={props.page} />
        </AuthProvider>
      </Match>
      <Match when={started.state === "errored"}>
        <main class="auth-page">
          <p class="auth-error" role="alert">{String(started.error)}</p>
        </main>
      </Match>
      <Match when={elapsed()}>
        <main class="auth-page" aria-busy="true" />
      </Match>
    </Switch>
  )
}

export function authScreen(page: () => JSX.Element) {
  return (_props: PageProps) => <AuthScreen page={page} />
}
