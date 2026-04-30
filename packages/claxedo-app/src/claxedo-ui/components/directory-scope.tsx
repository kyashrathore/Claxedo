/**
 * DirectoryScope
 *
 * Provides the full directory-level provider chain (SDK, Sync, Terminal, File, etc.)
 * accepting `directory` as a prop instead of reading from the URL via useParams().
 *
 * This enables multiple directory scopes to be mounted simultaneously in split mode,
 * each rendering their own session content with their own provider stack.
 *
 * The provider chain mirrors directory-layout.tsx but is decoupled from routing.
 */

import { type ParentProps, type ParentComponent, type JSX } from "solid-js"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { CommentScopeProvider, CommentsProvider } from "@/context/comments"
import { DataProvider } from "@opencode-ai/ui/context"
import { iife } from "@opencode-ai/util/iife"
import { getExtensions } from "@opencode-ai/app-shared"
import { base64Encode } from "@opencode-ai/util/encode"
import { WorkspaceSDKProvider } from "./workspace-sdk-provider"
import { useSessionParams } from "../context/session-params"

// Helper: wrap children with a list of providers
function wrapProviders(providers: ParentComponent[] | undefined, children: JSX.Element): JSX.Element {
  return (providers ?? []).reduceRight<JSX.Element>((acc, Provider) => <Provider>{acc}</Provider>, children)
}

export function DirectoryScope(props: ParentProps<{
  directory: string
  onNavigateToSession?: (sessionID: string) => void
  onSessionHref?: (sessionID: string) => string
  onSyncSession?: (sessionID: string) => void | Promise<void>
}>) {
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }
  return (
    <WorkspaceSDKProvider directory={() => props.directory}>
      <SyncProvider>
        {iife(() => {
          const sync = useSync()

          const navigateToSession = (sessionID: string) => {
            if (props.onNavigateToSession) {
              props.onNavigateToSession(sessionID)
            }
          }

          const sessionHref = props.onSessionHref
            ? (sessionID: string) => props.onSessionHref!(sessionID)
            : (sessionID: string) => {
                const dir = base64Encode(props.directory)
                return `/${dir}/session/${sessionID}`
              }

          const syncSession = (sessionID: string) => sync.session.sync(sessionID)

          const ext = getExtensions()

          return (
            <DataProvider
              data={sync.data}
              directory={props.directory}
              onNavigateToSession={navigateToSession}
              onSessionHref={sessionHref}
              onSyncSession={props.onSyncSession ?? syncSession}
            >
              <TerminalProvider>
                <FileProvider>
                  <PromptProvider>
                    <CommentScopeProvider
                      directory={() => props.directory}
                      sessionId={() => sessionParams?.sessionId?.()}
                    >
                      <CommentsProvider>
                        <LocalProvider sessionId={sessionParams?.sessionId}>
                          {wrapProviders(ext.app.directoryProviders, props.children)}
                        </LocalProvider>
                      </CommentsProvider>
                    </CommentScopeProvider>
                  </PromptProvider>
                </FileProvider>
              </TerminalProvider>
            </DataProvider>
          )
        })}
      </SyncProvider>
    </WorkspaceSDKProvider>
  )
}
