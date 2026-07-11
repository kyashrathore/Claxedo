// Claxedo owns branded fallback UI without upstream Sentry reporting.
import { TextField } from "@opencode-ai/ui/text-field"
import { ClaxedoLogo } from "@/claxedo-ui/components/claxedo-logo"
import { Button } from "@opencode-ai/ui/button"
import { Component, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"
import { formatError } from "./error-format"

export type { InitError } from "./error-format"

interface ErrorPageProps {
  error: unknown
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore({
    checking: false,
    version: undefined as string | undefined,
    actionError: undefined as string | undefined,
  })

  async function checkForUpdates() {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    await platform
      .checkUpdate()
      .then((result) => {
        setStore("actionError", undefined)
        if (result.updateAvailable && result.version) setStore("version", result.version)
      })
      .catch((err) => {
        setStore("actionError", formatError(err, language.t))
      })
      .finally(() => {
        setStore("checking", false)
      })
  }

  async function installUpdate() {
    if (!platform.updateAndRestart) return
    await platform
      .updateAndRestart()
      .then(() => setStore("actionError", undefined))
      .catch((err) => {
        setStore("actionError", formatError(err, language.t))
      })
  }

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <ClaxedoLogo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{language.t("error.page.title")}</h1>
          <p class="text-sm text-text-weak">{language.t("error.page.description")}</p>
        </div>
        <TextField
          value={formatError(props.error, language.t)}
          readOnly
          copyable
          multiline
          class="max-h-96 w-full font-mono text-xs no-scrollbar"
          label={language.t("error.page.details.label")}
          hideLabel
        />
        <div class="flex items-center gap-3">
          <Button size="large" onClick={platform.restart}>
            {language.t("error.page.action.restart")}
          </Button>
          <Show when={platform.checkUpdate}>
            <Show
              when={store.version}
              fallback={
                <Button size="large" variant="ghost" onClick={checkForUpdates} disabled={store.checking}>
                  {store.checking
                    ? language.t("error.page.action.checking")
                    : language.t("error.page.action.checkUpdates")}
                </Button>
              }
            >
              <Button size="large" onClick={installUpdate}>
                {language.t("error.page.action.updateTo", { version: store.version ?? "" })}
              </Button>
            </Show>
          </Show>
        </div>
        <Show when={store.actionError}>
          {(message) => <p class="text-xs text-text-on-critical-base text-center max-w-2xl">{message()}</p>}
        </Show>
        <div class="flex flex-col items-center gap-2">
          <div class="flex items-center justify-center gap-1">
            {language.t("error.page.report.prefix")}
            <button
              type="button"
              class="flex items-center text-text-interactive-base gap-1"
              onClick={() => platform.openLink("https://discord.gg/jSyhEQyT")}
            >
              <div>{language.t("error.page.report.discord")}</div>
              <Icon name="discord" class="text-text-interactive-base" />
            </button>
          </div>
          <Show when={platform.version}>
            {(version) => (
              <p class="text-xs text-text-weak">{language.t("error.page.version", { version: version() })}</p>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
