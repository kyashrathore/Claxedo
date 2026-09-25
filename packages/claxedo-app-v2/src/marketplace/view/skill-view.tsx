import { Match, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { MarkedProvider } from "@/ui"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { Markdown } from "@/transcript"
import { dictionary } from "../i18n"
import { skillBody } from "../model"
import { GHOST_ICON_BUTTON } from "./chrome"

function SkillBreadcrumb(props: {
  readonly pluginName: string
  readonly skill: string
  readonly onBack: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <nav
      aria-label={t("marketplace.skill.breadcrumb")}
      class="flex items-center gap-1.5 border-b border-border-weak-base px-4 py-2.5 text-12-regular"
    >
      <button
        type="button"
        aria-label={t("marketplace.skill.back", { name: props.pluginName })}
        class={`${GHOST_ICON_BUTTON} size-5`}
        onClick={() => props.onBack()}
      >
        ‹
      </button>
      <button type="button" class="truncate text-text-weak hover:text-text-base" onClick={() => props.onBack()}>
        {props.pluginName}
      </button>
      <span class="shrink-0 text-text-weaker">/</span>
      <span class="truncate text-text-strong">{props.skill}</span>
    </nav>
  )
}

export function SkillView(props: {
  readonly pluginInstanceId: string
  readonly pluginName: string
  readonly skill: string
  readonly onBack: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const server = useServer()
  const document = useQuery(() =>
    server.queries.marketplace.skill({ pluginInstanceId: props.pluginInstanceId, skill: props.skill }),
  )
  return (
    <div data-component="agent-plugin-skill-view" class="flex min-h-0 flex-1 flex-col">
      <SkillBreadcrumb pluginName={props.pluginName} skill={props.skill} onBack={props.onBack} />
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Switch fallback={<p class="text-12-regular text-text-weak">{t("marketplace.skill.reading")}</p>}>
          <Match when={document.error}>
            {(error) => <p class="text-12-regular text-icon-critical-base">{error().message}</p>}
          </Match>
          <Match when={document.data}>
            {(loaded) => (
              <article class="max-w-[68ch] text-14-regular text-text-base">
                <MarkedProvider>
                  <Markdown text={skillBody(loaded().markdown)} />
                </MarkedProvider>
              </article>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
