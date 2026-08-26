import type { ExecutionCapabilities, StreamDto } from "@claxedo/workgraph/contracts"
import { Show } from "solid-js"
import type { WorkGraphApiError } from "./api"
import type { LocalProjectOption } from "./project-picker"
import {
  StreamSettingsView,
  WorkGraphSettingsView,
  type StreamSettingsSource,
  type WorkGraphSettingsSource,
} from "./waiting/settings-dialogs"

export function WorkGraphSettingsPanel(props: {
  active: boolean
  stream?: StreamDto
  workgraphSource: WorkGraphSettingsSource
  streamSource: StreamSettingsSource
  capabilities?: ExecutionCapabilities
  capabilitiesError?: WorkGraphApiError
  capabilitiesLoading?: boolean
  localProjects?: readonly LocalProjectOption[]
  onChooseLocalProject?: () => Promise<string | undefined>
  onClose: () => void
}) {
  return (
    <Show
      when={props.stream}
      keyed
      fallback={
        <WorkGraphSettingsView
          active={props.active}
          source={props.workgraphSource}
          capabilities={props.capabilities}
          capabilitiesError={props.capabilitiesError}
          capabilitiesLoading={props.capabilitiesLoading}
          onClose={props.onClose}
        />
      }
    >
      {(stream) => (
        <StreamSettingsView
          active={props.active}
          stream={stream}
          source={props.streamSource}
          capabilities={props.capabilities}
          capabilitiesError={props.capabilitiesError}
          capabilitiesLoading={props.capabilitiesLoading}
          localProjects={props.localProjects}
          onChooseLocalProject={props.onChooseLocalProject}
          onClose={props.onClose}
        />
      )}
    </Show>
  )
}
