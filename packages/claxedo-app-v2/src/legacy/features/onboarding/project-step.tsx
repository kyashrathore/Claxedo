import type { Component } from "solid-js"
import { ProjectCreateForm } from "./app-ports"
import type { ProjectSource } from "./draft"

/**
 * Step 1: where the code is. The form's own submit is this step's Continue;
 * it hands the choice out rather than posting it, because the project is
 * created at Finish (a desktop) or never at all (the hosted plane, where the
 * repository becomes the first cloud workspace's source).
 */
export const ProjectStep: Component<{
  baseUrl: string
  localExecution: boolean
  pickFolder?: () => Promise<string | undefined>
  leadField?: (element: HTMLElement) => void
  onChosen: (source: ProjectSource) => void
}> = (props) => (
  <ProjectCreateForm
    size="comfortable"
    baseUrl={props.baseUrl}
    localExecution={props.localExecution}
    {...(props.pickFolder ? { pickFolder: props.pickFolder } : {})}
    {...(props.leadField ? { leadField: props.leadField } : {})}
    submitLabel="Continue"
    onSubmit={(source) => props.onChosen(source)}
  />
)
