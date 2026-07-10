import { Show } from "solid-js"
import { Terminal, type TerminalProps } from "../components/terminal"
import { useSDK } from "../context/sdk"
import { workspacePlacement } from "../shell/workspace/workspace-connection"
import { terminalBlockedByRole } from "./terminal-role-gate"

export function RoleGuardedTerminal(props: TerminalProps) {
  const sdk = useSDK()
  const blocked = () => terminalBlockedByRole(workspacePlacement(sdk.workspaceId))

  return (
    <Show
      when={!blocked()}
      fallback={
        <div class="flex h-full w-full items-center justify-center px-4 text-center text-sm text-text-weak">
          Workspace role does not allow terminal access.
        </div>
      }
    >
      <Terminal {...props} />
    </Show>
  )
}
