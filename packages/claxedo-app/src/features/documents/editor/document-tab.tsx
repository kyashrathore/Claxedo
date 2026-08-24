import { createEffect } from "solid-js"
import { Match, Switch, createTrackedEffect, createSignal } from "solid-js"
import { DocumentApiError, documentsApi, type OpenDocument } from "../data/documents-api"
import DocumentEditor from "./document-editor"
import { DocumentRecoveryState } from "./recovery-states"

export type TabPageProps = {
  pageId: string
  sessionId?: string
  directory?: string
  filePath?: string
  leafId?: string
  surfaceId?: string
  onTitleChange?: (title: string) => void
  onBackToIndex?: () => void
}

export function TabPage(props: TabPageProps) {
  const [document, setDocument] = createSignal<OpenDocument>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<unknown>()
  let sequence = 0

  const load = async (id: string) => {
    const request = ++sequence
    setLoading(true)
    setError(undefined)
    try {
      const opened = await documentsApi.open(id)
      if (request === sequence) setDocument(opened)
    } catch (next) {
      if (request === sequence) setError(next)
    }
    if (request === sequence) setLoading(false)
  }

  void load(props.pageId)
  createEffect(
    () => props.pageId,
    (id) => void load(id),
    { defer: true },
  )

  const recoveryKind = () => {
    const current = error()
    if (current instanceof DocumentApiError && current.code === "document_archived") return "archived" as const
    if (current instanceof DocumentApiError && current.status === 404) return "missing" as const
    return "error" as const
  }
  const errorMessage = () => {
    const current = error()
    return current instanceof Error ? current.message : String(current)
  }

  return (
    <div class="relative flex size-full min-h-0 flex-col overflow-hidden bg-background-base">
      <Switch>
        <Match when={loading()}>
          <div class="px-6 py-8 text-sm text-text-weak" role="status">
            Loading document…
          </div>
        </Match>
        <Match when={error()}>
          {(next) => (
            <DocumentRecoveryState
              kind={recoveryKind()}
              message={errorMessage()}
              onBack={props.onBackToIndex}
              onRetry={() => void load(props.pageId)}
            />
          )}
        </Match>
        <Match when={document()}>
          {(next) => (
            <DocumentEditor
              document={next()}
              onTitleChange={props.onTitleChange}
              onBackToIndex={props.onBackToIndex}
              reportError={(error) => console.error("[documents] editor persistence error", error)}
            />
          )}
        </Match>
      </Switch>
    </div>
  )
}
