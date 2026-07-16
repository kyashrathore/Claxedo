import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { detectMarkdown, type MarkdownDetection } from "@/features/documents/markdown/detector"
import {
  createDocumentPersistenceController,
  type DocumentPersistenceController,
  type PersistenceSnapshot,
} from "@/features/documents/state/persistence-controller"
import { createRecoveryDraftStore, type RecoveryDraftStorage } from "@/features/documents/state/recovery-draft"
import {
  DocumentApiError,
  documentsApi,
  type DocumentsApi,
  type OpenDocument,
} from "@/features/documents/data/documents-api"
import { ConflictRecovery } from "./conflict-recovery"
import { DocumentRecoveryState } from "./recovery-states"
import { RichMode } from "./rich-mode"
import { SaveStatus } from "./save-status"
import { SourceMode } from "./source-mode"
import { createDocumentExternalChangeController } from "./external-change"
import { VersionHistory } from "./version-history"

export type DocumentEditorProps = {
  document: OpenDocument
  api?: Pick<DocumentsApi, "save" | "create"> &
    Partial<Pick<DocumentsApi, "open" | "watch" | "snapshots" | "restoreSnapshot">>
  storage?: RecoveryDraftStorage
  onTitleChange?: (title: string) => void
  onBackToIndex?: () => void
  onBlockingClose?: (snapshot: PersistenceSnapshot) => void
  onUnavailable?: (error: unknown) => void
  onController?: (controller: DocumentPersistenceController) => void
  reportError?: (error: unknown) => void
  transformSelection?: (action: "improve" | "fix" | "shorten", selected: string) => Promise<string>
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
  const unsubscribe = controller.subscribe(setSnapshot)
  props.onController?.(controller)

  const external =
    api.open && api.watch
      ? createDocumentExternalChangeController({
          documentId: props.document.id,
          projectId: props.document.summary.project_id,
          watch: api.watch,
          read: async () => {
            const current = await api.open!(props.document.id)
            return { displayName: current.displayName, markdown: current.markdown, version: current.version }
          },
          apply: (current) => {
            const before = controller.snapshot()
            const applied = controller.applyExternalChange(current)
            if (applied.status === "conflicted") return
            if (applied.draft.markdown !== before.draft.markdown) {
              setDetection(detectMarkdown(applied.draft.markdown))
            }
            if (applied.draft.displayName !== before.draft.displayName) {
              props.onTitleChange?.(applied.draft.displayName)
            }
          },
          isUnavailable: (error) =>
            error instanceof DocumentApiError && (error.status === 404 || error.code === "document_archived"),
          onUnavailable: props.onUnavailable ?? reportError,
          onError: reportError,
          schedule: (run, delay) => {
            const timer = setTimeout(run, delay)
            return () => clearTimeout(timer)
          },
          subscribeFocus: (refresh) => {
            if (typeof window === "undefined") return () => undefined
            window.addEventListener("focus", refresh)
            return () => window.removeEventListener("focus", refresh)
          },
        })
      : undefined
  onMount(() => external?.start())

  const editMarkdown = (markdown: string) => controller.editMarkdown(markdown)
  const flush = () => controller.flushOnBlur().then(undefined, reportError)
  const tryRich = () => setDetection(detectMarkdown(snapshot().draft.markdown))
  const editSource = () =>
    setDetection({
      status: "source",
      markdown: snapshot().draft.markdown,
      reason: {
        code: "manual",
        message: "Source mode was selected for direct Markdown editing.",
      },
    })
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
    external?.stop()
    unsubscribe()
    void controller.flushOnClose().then((result) => {
      if (result.status === "failed" || result.status === "conflicted") props.onBlockingClose?.(result)
    }, reportError)
  })

  return (
    <main class="flex size-full min-h-0 flex-col bg-background-base" aria-label="Document editor">
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
        <button
          type="button"
          class="rounded px-2 py-1 text-xs text-text-weak hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
          onClick={() => void controller.flushBeforeAction()}
        >
          Save now
        </button>
        <SaveStatus snapshot={snapshot()} onRetry={() => void controller.retry()} />
        <Show when={api.snapshots && api.restoreSnapshot && api.open}>
          <VersionHistory
            list={() => api.snapshots!(props.document.id)}
            restore={restoreSnapshot}
            reportError={reportError}
          />
        </Show>
        <details class="relative text-xs text-text-weak">
          <summary class="cursor-pointer rounded px-2 py-1 hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2">
            More
          </summary>
          <div class="absolute right-0 z-20 mt-1 w-56 rounded border border-border-weak-base bg-background-base p-2 shadow-lg">
            <p>Repository actions are not available for this document yet.</p>
          </div>
        </details>
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
                  onEditSource={editSource}
                  onSelectionAction={props.transformSelection}
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
