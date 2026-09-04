import { createResource, Show } from "solid-js"
import { Markdown } from "@/ui/session-kit"
import type { AgentPluginApi } from "../api"
import { GHOST_ICON_BUTTON } from "./chrome"
import { skillBody } from "./view"

/**
 * One skill, read as a document.
 *
 * A SKILL.md is prose written to be read top to bottom, so the pane navigates
 * to it instead of unfolding it in place: an accordion inside a 420px column
 * gives a 900-word document a 200px window and loses the reader's place on
 * every toggle. The breadcrumb is the only way back, plus Escape.
 */
export function SkillView(props: {
  api: AgentPluginApi
  pluginInstanceId: string
  pluginName: string
  skill: string
  projectId?: string
  onBack: () => void
}) {
  const [document] = createResource(
    () => ({ pluginInstanceId: props.pluginInstanceId, skill: props.skill, projectId: props.projectId }),
    (options) => props.api.skill({
      pluginInstanceId: options.pluginInstanceId,
      skill: options.skill,
      ...(options.projectId ? { projectId: options.projectId } : {}),
    }),
  )
  return (
    <div data-component="agent-plugin-skill-view" class="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Breadcrumb"
        class="flex items-center gap-1.5 border-b border-border-weak-base px-4 py-2.5 text-12-regular"
      >
        <button
          type="button"
          aria-label={`Back to ${props.pluginName}`}
          class={`${GHOST_ICON_BUTTON} size-5`}
          onClick={() => props.onBack()}
        >
          ‹
        </button>
        <button
          type="button"
          class="truncate text-text-weak hover:text-text-base"
          onClick={() => props.onBack()}
        >
          {props.pluginName}
        </button>
        <span class="shrink-0 text-text-weaker">/</span>
        <span class="truncate text-text-strong">{props.skill}</span>
      </nav>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Show when={document.error}>
          <p class="text-12-regular text-icon-critical-base">{String(document.error)}</p>
        </Show>
        <Show when={document.loading}>
          <p class="text-12-regular text-text-weak">Reading SKILL.md…</p>
        </Show>
        <Show when={document()}>
          {(loaded) => (
            <article class="max-w-[68ch] text-14-regular text-text-base">
              <Markdown text={skillBody(loaded().markdown)} />
            </article>
          )}
        </Show>
      </div>
    </div>
  )
}
