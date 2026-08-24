import type { ExecutionBudget, StreamDto } from "@claxedo/workgraph/contracts"
import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { RichTextEditor } from "@/ui/rich-text"
import { Show } from "solid-js"
import type { WorkGraphApiError } from "./api"
import { BaseRevisionChip, StatusBanner } from "./content-chrome"
import { ProjectPicker, type LocalProjectOption } from "./project-picker"
import { WorkGraphDialog } from "./waiting/workgraph-dialog"

export type StreamEnvironmentKind = "local_worktree" | "hosted_workspace"
export type StreamEnvironmentOption = { kind: StreamEnvironmentKind; label: string }

export function StreamCreateDialog(props: {
  open: boolean
  expanded: boolean
  title: string
  description: string
  environment: StreamEnvironmentKind
  environmentOptions: StreamEnvironmentOption[]
  currentEnvironmentOption: StreamEnvironmentOption
  localDirectory: string
  localProjects: readonly LocalProjectOption[]
  repositoryUrl: string
  baseRevision: string
  baseRevisionOptions: string[]
  parent?: StreamDto
  budgetCarve: string
  mutationError?: WorkGraphApiError
  capabilityError?: WorkGraphApiError
  submitting: boolean
  invalid: boolean
  confirmingPromotion: boolean
  onClose: () => void
  onToggleExpanded: () => void
  onSubmit: (event: SubmitEvent) => void
  onTitle: (value: string) => void
  onDescription: (value: string) => void
  onEnvironment: (value: StreamEnvironmentKind) => void
  onLocalDirectory: (value: string) => void
  onChooseLocalProject?: () => Promise<string | undefined>
  onProjectError: (error: unknown) => void
  onRepositoryUrl: (value: string) => void
  onBaseRevision: (value: string) => void
  onBudgetCarve: (value: string) => void
  onRetryMutation: () => void
  onRetryCapabilities: () => void
  onCancelPromotion: () => void
  onConfirmPromotion: () => void
}) {
  const budget = () => props.parent?.executionDefaults.budget as ExecutionBudget | undefined
  return (
    <>
      <DialogRoot
        modal
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
      >
        <DialogRoot.Portal>
          <div class={["workgraph-dialog-scope", { "is-expanded": props.expanded }]}>
            <DialogRoot.Overlay data-component="dialog-overlay" />
            <DialogShell
              fit={!props.expanded}
              size={props.expanded ? "large" : "normal"}
              title={props.parent ? "Promote child Stream" : "New stream"}
              onEscapeKeyDown={props.onClose}
              action={
                <div class="flex items-center gap-0.5">
                  <IconButton
                    variant="ghost"
                    size="small"
                    icon={props.expanded ? "collapse" : "expand"}
                    aria-label={props.expanded ? "Shrink dialog" : "Expand dialog"}
                    onClick={props.onToggleExpanded}
                  />
                  <IconButton variant="ghost" size="small" icon="close" aria-label="Close" onClick={props.onClose} />
                </div>
              }
            >
              <form
                onSubmit={props.onSubmit}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return
                  event.preventDefault()
                  event.currentTarget.requestSubmit()
                }}
                class="workgraph-create-form"
              >
                <Show when={props.parent}>
                  {(parent) => (
                    <div class="workgraph-create-promotion" role="note">
                      Parent · {parent().title}
                    </div>
                  )}
                </Show>
                <label for="workgraph-stream-title" class="sr-only">
                  What are you trying to ship?
                </label>
                <input
                  id="workgraph-stream-title"
                  autofocus
                  value={props.title}
                  onInput={(event) => props.onTitle(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return
                    event.preventDefault()
                    event.currentTarget.closest("form")?.querySelector<HTMLElement>(".richtext-surface")?.focus()
                  }}
                  class="workgraph-create-title"
                  placeholder="Stream title"
                />
                <div class="workgraph-create-desc">
                  <RichTextEditor
                    value={props.description}
                    onChange={props.onDescription}
                    ariaLabel="Description"
                    placeholder="Add a description…"
                  />
                </div>
                <div class="workgraph-create-chips" role="group" aria-label="Stream defaults">
                  <Select<StreamEnvironmentOption>
                    size="normal"
                    variant="ghost"
                    options={props.environmentOptions}
                    current={props.currentEnvironmentOption}
                    value={(option) => option.kind}
                    label={(option) => option.label}
                    onSelect={(option) => {
                      if (option) props.onEnvironment(option.kind)
                    }}
                    class="workgraph-chip-select text-text-base"
                    valueClass="truncate text-13-regular text-text-weak"
                  />
                  <Show when={props.environment === "local_worktree"}>
                    <ProjectPicker
                      value={props.localDirectory}
                      projects={props.localProjects}
                      onChange={props.onLocalDirectory}
                      onChoose={props.onChooseLocalProject}
                      onError={props.onProjectError}
                    />
                  </Show>
                  {/* A base revision only means something once a repository is
                      chosen. With no project selected there is nothing to
                      enumerate refs from, so the picker is absent rather than
                      showing revisions that belong to some other repository. */}
                  <Show when={props.environment !== "local_worktree" || props.localDirectory.trim()}>
                    <BaseRevisionChip
                      value={props.baseRevision}
                      options={props.baseRevisionOptions}
                      onChange={props.onBaseRevision}
                    />
                  </Show>
                </div>
                <Show when={props.environment === "hosted_workspace"}>
                  <label class="workgraph-create-target">
                    <span>GitHub repository URL</span>
                    <input
                      value={props.repositoryUrl}
                      onInput={(event) => props.onRepositoryUrl(event.currentTarget.value)}
                      placeholder="https://github.com/owner/repository.git"
                      required
                    />
                    <small>The cloud workspace clones this repository for every Stream Run.</small>
                  </label>
                </Show>
                <Show when={budget()}>
                  {(parentBudget) => (
                    <label class="workgraph-create-target">
                      <span>Budget carve</span>
                      <input
                        aria-label="Budget carve"
                        type="number"
                        min="0"
                        max={parentBudget().amount}
                        step={parentBudget().unit === "tokens" ? "1" : "0.01"}
                        value={props.budgetCarve}
                        onInput={(event) => props.onBudgetCarve(event.currentTarget.value)}
                        required
                      />
                      <small>
                        {parentBudget().unit} / {parentBudget().window}; must leave budget on the parent Stream.
                      </small>
                    </label>
                  )}
                </Show>
                <Show when={props.mutationError}>
                  {(error) => <StatusBanner error={error()} retry={props.onRetryMutation} />}
                </Show>
                <Show when={props.capabilityError}>
                  {(error) => <StatusBanner error={error()} retry={props.onRetryCapabilities} />}
                </Show>
                <div class="workgraph-create-actions">
                  <span class="workgraph-create-hint text-text-weaker">
                    <kbd>⌘</kbd> <kbd>↵</kbd> to create
                  </span>
                  <div class="flex gap-2">
                    <Button type="button" size="small" variant="ghost" onClick={props.onClose}>
                      Cancel
                    </Button>
                    <Button type="submit" size="small" variant="primary" disabled={props.invalid}>
                      {props.submitting ? "Creating…" : props.parent ? "Review promotion" : "Create"}
                    </Button>
                  </div>
                </div>
              </form>
            </DialogShell>
          </div>
        </DialogRoot.Portal>
      </DialogRoot>
      <WorkGraphDialog
        open={props.confirmingPromotion}
        onClose={props.onCancelPromotion}
        title="Confirm child Stream promotion"
        fit
        footer={
          <>
            <Button size="small" variant="ghost" onClick={props.onCancelPromotion}>
              Cancel
            </Button>
            <Button size="small" variant="primary" disabled={props.submitting} onClick={props.onConfirmPromotion}>
              {props.submitting ? "Promoting…" : "Confirm promotion"}
            </Button>
          </>
        }
      >
        <p class="text-sm leading-5 text-text-base">
          {budget()
            ? `This creates a standing child master and carves ${props.budgetCarve || "0"} ${budget()!.unit} from ${props.parent?.title}.`
            : `This creates a standing child master under ${props.parent?.title}.`}
        </p>
      </WorkGraphDialog>
    </>
  )
}
