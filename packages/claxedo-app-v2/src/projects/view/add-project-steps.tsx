import { createMemo, Show, type Component } from "solid-js"
import { ScrollView } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText } from "../i18n"
import { addProjectStep, addProjectSteps } from "../model"
import { AgentStep } from "./agent-step"
import { FlowFooter } from "./flow-footer"
import { PlacementStep } from "./placement-step"
import { SourceStep } from "./source-step"
import "./projects.css"

export const AddProjectSteps: Component<{
  flow: AddProjectFlow
  panelsRef?: (element: HTMLDivElement) => void
}> = (props) => {
  const t = useProjectsText()
  const step = createMemo(() => addProjectStep(props.flow.state()))
  const index = () => {
    const current = step()
    return current === "done" ? addProjectSteps.length : addProjectSteps.indexOf(current)
  }
  const reached = createMemo<number>((previous) => Math.max(previous, index()), 0)

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="add-project" data-step={step()}>
      <ScrollView class="min-h-0 flex-1" label={t("projects.add.title")}>
        <div ref={props.panelsRef} data-slot="add-project-panels">
          <div hidden={step() !== "source"} data-step-panel="source">
            <SourceStep flow={props.flow} />
          </div>
          <Show when={reached() >= 1}>
            <div hidden={step() !== "agent"} data-step-panel="agent">
              <AgentStep flow={props.flow} />
            </div>
          </Show>
          <Show when={reached() >= 2}>
            <div hidden={step() !== "placement"} data-step-panel="placement">
              <PlacementStep flow={props.flow} />
            </div>
          </Show>
        </div>
      </ScrollView>
      <FlowFooter flow={props.flow} />
    </div>
  )
}
