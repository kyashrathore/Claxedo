import { WorkspaceProcessesNavigator } from "@/features/processes/ui"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useWorkspaceProcessPane } from "../context/process-pane"

/** The processes navigator bound to the shared per-workspace process pane. */
export function ProcessesNavigator(props: {
  directory: Parameters<typeof WorkspaceProcessesNavigator>[0]["directory"]
  activeProcessId?: string
  onProcessSelect: (processId: string) => void
}) {
  const processPane = useWorkspaceProcessPane()
  const platform = usePlatform()
  return <WorkspaceProcessesNavigator {...props} processPane={processPane} request={platform.fetch} />
}
