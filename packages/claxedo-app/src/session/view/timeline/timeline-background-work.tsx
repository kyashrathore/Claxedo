import { Show } from "solid-js"
import type { BackgroundWork } from "@/server"
import { Tooltip } from "@/ui"
import { backgroundWorkLabel } from "./background-work-label"
import type { TimelineTranslate } from "./model"

export function TimelineBackgroundWork(props: { work: BackgroundWork; t: TimelineTranslate; tucked: boolean }) {
  const label = () => backgroundWorkLabel(props.work, props.t)
  return (
    <Show when={label()}>
      {(text) => (
        <div data-slot="session-background-work" class="relative w-full px-4 md:px-5 pb-2 md:max-w-[var(--transcript-measure,48rem)] md:mx-auto" classList={{ "-mt-10": props.tucked }}>
          <Tooltip placement="top" value={props.t("session.timeline.backgroundWork.hint")}>
            <span tabIndex={0} class="text-13-regular text-text-weak cursor-default">{text()}</span>
          </Tooltip>
        </div>
      )}
    </Show>
  )
}
