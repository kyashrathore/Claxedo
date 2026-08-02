import type { StreamDto } from "@claxedo/workgraph/contracts"
import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { createResource, Show } from "solid-js"
import { normalizeError } from "./content-chrome"
import type { WorkGraphClient } from "./api"

export function StreamNotesDialog(props: { stream?: StreamDto; client: WorkGraphClient; onClose: () => void }) {
  const [revision] = createResource(
    () => props.stream?.notesSource,
    (source) => props.client.sourceRevision(source.workSourceId, source.revisionId),
  )
  return (
    <DialogRoot modal open={!!props.stream} onOpenChange={(open) => !open && props.onClose()}>
      <DialogRoot.Portal>
        <div class="workgraph-dialog-scope">
          <DialogRoot.Overlay data-component="dialog-overlay" />
          <DialogShell fit size="normal" title={`Notes · ${props.stream?.title ?? "Stream"}`} onEscapeKeyDown={props.onClose}
            action={<IconButton variant="ghost" size="small" icon="close" aria-label="Close notes" onClick={props.onClose} />}>
            <Show when={!revision.loading && !revision.error && revision()} fallback={
              <div class="workgraph-detail-status" role="status">
                {revision.error ? normalizeError(revision.error).message : "Loading notes…"}
              </div>
            }>
              {(value) => <pre class="workgraph-stream-notes">{value().content}</pre>}
            </Show>
          </DialogShell>
        </div>
      </DialogRoot.Portal>
    </DialogRoot>
  )
}
