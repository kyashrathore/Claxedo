import { useLocation } from "@solidjs/router"
import { Match, Switch } from "solid-js"
import { appUrl, useAuth } from "@/auth"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { Button, showToast } from "@/ui"
import { accessDictionary } from "../i18n"
import "./access.css"

export function SignedOutNotice() {
  const t = useTranslator(accessDictionary)
  const auth = useAuth()
  const server = useServer()
  const location = useLocation()
  const offered = () => auth.offered(server.capabilities()?.signedIn === true)
  const signIn = () =>
    void auth.signIn({ redirectUrl: appUrl(location) }).catch((error: unknown) => {
      showToast({ title: t("access.org.signInFailed"), description: error instanceof Error ? error.message : String(error) })
    })
  return (
    <Switch fallback={<p class="org-note">{t("access.org.signedOut")}</p>}>
      <Match when={auth.state().kind === "signingIn"}>
        <p class="org-note" role="status">{t("access.org.checking")}</p>
      </Match>
      <Match when={offered()}>
        <div class="org-sign-in">
          <p class="org-note">{t("access.org.signedOut")}</p>
          <Button size="small" variant="neutral" onClick={signIn}>
            {t("access.org.signIn")}
          </Button>
        </div>
      </Match>
    </Switch>
  )
}
