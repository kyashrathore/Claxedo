import { Match, Show, Switch, createSignal, onCleanup } from "solid-js"
import { detectMarkdown, type MarkdownDetection } from "@/features/documents/markdown/detector"
import {
  createDocumentPersistenceController,
  type DocumentPersistenceController,
  type PersistenceSnapshot,
} from "@/features/documents/state/persistence-controller"
import { createRecoveryDraftStore, type RecoveryDraftStorage } from "@/features/documents/state/recovery-draft"
import { documentsApi, type DocumentsApi, type OpenDocument } from "@/features/documents/data/documents-api"
import { ConflictRecovery } from "./conflict-recovery"
import { DocumentRecoveryState } from "./recovery-states"
import { RichMode } from "./rich-mode"
import { SaveStatus } from "./save-status"
import { SourceMode } from "./source-mode"
import { VersionHistory } from "./version-history"

export type DocumentEditorProps = {
  document: OpenDocument
  api?: Pick<DocumentsApi, "save" | "create"> &
    Partial<Pick<DocumentsApi, "open" | "snapshots" | "restoreSnapshot">>
  storage?: RecoveryDraftStorage
  onTitleChange?: (title: string) => void
  onBackToIndex?: () => void
  onBlockingClose?: (snapshot: PersistenceSnapshot) => void
  onController?: (controller: DocumentPersistenceController) => void
  reportError?: (error: unknown) => void
}

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

export default function DocumentEditor(props: DocumentEditorProps) {
  const api = props.api ?? documentsApi
  const reportError = props.reportError ?? ((error: unknown) => console.error(error))
  const controller = createDocumentPersistenceController({
    document: {
      id: props.document.id,
      displayName: props.document.displayName,
      markdown: props.document.markdown,
      version: props.document.version,
    },
    save: (request) => api.save(props.document.id, request),
    recovery: createRecoveryDraftStore(
      props.storage ?? (typeof localStorage === "undefined" ? memoryStorage() : localStorage),
    ),
    schedule: (handler, delay) => {
      const timer = setTimeout(handler, delay)
      return () => clearTimeout(timer)
    },
    now: Date.now,
    reportError,
  })
  const [snapshot, setSnapshot] = createSignal(controller.snapshot())
  const [detection, setDetection] = createSignal<MarkdownDetection>(detectMarkdown(snapshot().draft.markdown))
  const [editorError, setEditorError] = createSignal<string>()
  const [richUnavailable, setRichUnavailable] = createSignal(false)
  const unsubscribe = controller.subscribe(setSnapshot)
  props.onController?.(controller)

  const editMarkdown = (markdown: string) => {
    setRichUnavailable(false)
    controller.editMarkdown(markdown)
  }
  const flush = () => controller.flushOnBlur().then(undefined, reportError)
  // A recheck that lands back on source renders an identical screen, so say so explicitly —
  // otherwise the button reads as broken.
  const tryRich = () => {
    const next = detectMarkdown(snapshot().draft.markdown)
    setDetection(next)
    setRichUnavailable(next.status === "source")
  }
  const rejectedReason = () => {
    const value = detection()
    return value.status === "rejected" ? value.reason.message : "The document cannot be edited."
  }
  const reload = () => {
    const reloaded = controller.reloadFromConflict()
    setDetection(detectMarkdown(reloaded.draft.markdown))
    props.onTitleChange?.(reloaded.draft.displayName)
  }
  const saveCopy = async () => {
    const draft = controller.draftForSaveAsCopy()
    if (!draft) return
    await api.create({
      projectId: props.document.summary.project_id,
      displayName: `${draft.displayName} copy`,
      markdown: draft.markdown,
    })
  }
  const restoreSnapshot = async (snapshotId: string) => {
    if (!api.restoreSnapshot || !api.open) return
    const flushed = await controller.flushBeforeAction()
    if (flushed.status === "failed" || flushed.status === "conflicted") {
      props.onBlockingClose?.(flushed)
      return
    }
    await api.restoreSnapshot(props.document.id, snapshotId, flushed.expectedVersion)
    const restored = await api.open(props.document.id)
    controller.applyExternalChange({
      displayName: restored.displayName,
      markdown: restored.markdown,
      version: restored.version,
    })
    setDetection(detectMarkdown(restored.markdown))
    props.onTitleChange?.(restored.displayName)
  }

  onCleanup(() => {
    unsubscribe()
    void controller.flushOnClose().then((result) => {
      if (result.status === "failed" || result.status === "conflicted") props.onBlockingClose?.(result)
    }, reportError)
  })

  return (
    <main
      class="flex size-full min-h-0 flex-col bg-background-base"
      aria-label="Document editor"
      onKeyDown={(event) => {
        // Autosave already covers this; Cmd+S only exists so the reflex isn't a dead key.
        if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return
        event.preventDefault()
        void controller.flushBeforeAction().then(undefined, reportError)
      }}
    >
      <header class="flex items-center gap-3 border-b border-border-weak-base px-6 py-3">
        {props.onBackToIndex && (
          <button
            type="button"
            class="rounded px-2 py-1 text-xs text-text-weak hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
            onClick={() =>
              void controller.flushBeforeAction().then((result) => {
                if (result.status === "failed" || result.status === "conflicted") {
                  props.onBlockingClose?.(result)
                  return
                }
                props.onBackToIndex?.()
              }, reportError)
            }
          >
            Documents
          </button>
        )}
        <div class="flex-1" />
        <SaveStatus snapshot={snapshot()} onRetry={() => void controller.retry()} />
        <Show when={api.snapshots && api.restoreSnapshot && api.open}>
          <VersionHistory
            list={() => api.snapshots!(props.document.id)}
            restore={restoreSnapshot}
            reportError={reportError}
          />
        </Show>
      </header>

      <div class="min-h-0 flex-1 overflow-auto">
        <div class="notion-page-shell">
          <input
            aria-label="Document name"
            class="notion-title"
            placeholder="Untitled"
            value={snapshot().draft.displayName}
            onInput={(event) => {
              controller.editDisplayName(event.currentTarget.value)
              props.onTitleChange?.(event.currentTarget.value)
            }}
            onBlur={flush}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              const rich = event.currentTarget
                .closest(".notion-page-shell")
                ?.querySelector<HTMLElement>('[aria-label="Document rich editor"]')
              rich?.focus()
            }}
          />

          <Switch>
            <Match when={detection().status === "rejected"}>
              <DocumentRecoveryState kind="rejected" message={rejectedReason()} onBack={props.onBackToIndex} />
            </Match>
            <Match when={detection().status === "source" && detection()}>
              {(value) => {
                const source = value() as Extract<MarkdownDetection, { status: "source" }>
                return (
                  <SourceMode
                    markdown={snapshot().draft.markdown}
                    reason={source.reason.message}
                    unavailable={richUnavailable()}
                    onInput={editMarkdown}
                    onBlur={flush}
                    onTryRich={tryRich}
                  />
                )
              }}
            </Match>
            <Match when={detection().status === "rich" && detection()}>
              {(value) => (
                <RichMode
                  detection={value() as Extract<MarkdownDetection, { status: "rich" }>}
                  onInput={editMarkdown}
                  onBlur={flush}
                  onSerializationError={(error) => {
                    setEditorError(error.message)
                    reportError(error)
                  }}
                />
              )}
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={editorError()}>
        {(message) => (
          <p class="border-t border-border-critical-base px-6 py-2 text-xs text-text-on-critical-base" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Show when={snapshot().conflict}>
        {(conflict) => (
          <ConflictRecovery
            conflict={conflict()}
            onReload={reload}
            onSaveCopy={() => void saveCopy().catch(reportError)}
            onOverwrite={() => void controller.confirmOverwrite()}
          />
        )}
      </Show>
    </main>
  )
}
