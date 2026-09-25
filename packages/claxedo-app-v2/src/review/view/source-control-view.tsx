import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import {
  toAppError,
  type DiffScope,
  type DiffSummary,
  type GitCommit,
  type GitStatus,
  type PlacementId,
} from "@/server"
import { useReviewApi } from "../api"
import { useErrorText } from "../errors"
import { createGitActions, type GitAction } from "../git-actions"
import { dictionary } from "../i18n"
import { commitScope, shortRef } from "../intent"
import { defaultScope } from "../model"
import { useReview } from "../store"
import { ChangeGroup, type ChangeEntry } from "./change-group"
import { CommitGraph } from "./commit-graph"
import { CompareGroup } from "./compare-group"
import { useCompareUrl } from "../create-pr"
import { PushRow } from "./push-row"
import { CommitBox, type CommitVariant } from "./source-control-commit-box"
import "./source-control.css"

const GRAPH_LIMIT = 50

type Section = "compare" | "staged" | "changes" | "graph"

type CompareScope = Extract<DiffScope, { readonly kind: "branch" | "branchWorktree" | "range" }>

const EMPTY_STATUS: GitStatus = { ahead: 0, behind: 0, staged: [], unstaged: [] }

function compareScopeOf(scope: DiffScope): CompareScope | undefined {
  return scope.kind === "branch" || scope.kind === "branchWorktree" || scope.kind === "range" ? scope : undefined
}

function compareEntries(summaries: readonly DiffSummary[] | undefined): readonly ChangeEntry[] | undefined {
  return summaries?.map((summary) => ({
    path: summary.file,
    status: summary.status ?? "modified",
    additions: summary.additions,
    deletions: summary.deletions,
  }))
}

function LoadingRows(): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div
      data-testid="source-control-loading"
      aria-label={t("review.sourceControl.loading")}
      class="flex flex-col gap-1 p-2"
    >
      <div class="h-6 w-[82%] rounded-md bg-surface-base" />
      <div class="h-6 w-[69%] rounded-md bg-surface-base" />
      <div class="h-6 w-[54%] rounded-md bg-surface-base" />
    </div>
  )
}

function createSections() {
  const [collapsed, setCollapsed] = createSignal<Readonly<Record<Section, boolean>>>({
    compare: false,
    staged: false,
    changes: false,
    graph: true,
  })
  const toggle = (section: Section) => setCollapsed((current) => ({ ...current, [section]: !current[section] }))
  return { collapsed, toggle }
}

function WorktreeGroups(props: {
  readonly status: GitStatus
  readonly scope: DiffScope
  readonly sections: ReturnType<typeof createSections>
  readonly activePath?: string
  readonly pending?: GitAction
  readonly onStage: (paths: string[]) => void
  readonly onUnstage: (paths: string[]) => void
  readonly onOpen: (entry: ChangeEntry, scope: DiffScope) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <>
      <ChangeGroup
        id="staged"
        entries={props.status.staged}
        collapsed={props.sections.collapsed().staged}
        active={props.scope.kind === "staged"}
        onToggle={() => props.sections.toggle("staged")}
        activePath={props.activePath}
        pending={props.pending}
        onAction={props.onUnstage}
        onOpen={(entry) => props.onOpen(entry, { kind: "staged" })}
      />
      <ChangeGroup
        id="changes"
        entries={props.status.unstaged}
        collapsed={props.sections.collapsed().changes}
        active={props.scope.kind === "unstaged"}
        onToggle={() => props.sections.toggle("changes")}
        activePath={props.activePath}
        pending={props.pending}
        onAction={props.onStage}
        onOpen={(entry) => props.onOpen(entry, { kind: "unstaged" })}
      />
      <Show when={props.status.staged.length === 0 && props.status.unstaged.length === 0}>
        <div data-testid="source-control-empty" class="px-3 py-2 text-12-regular text-text-weak">
          {t("review.sourceControl.empty")}
        </div>
      </Show>
    </>
  )
}

export type SourceControlViewProps = {
  readonly placementId: PlacementId
  readonly active: boolean
  readonly activePath?: string
  readonly onFileClick: (path: string) => void
}

export function SourceControlView(props: SourceControlViewProps): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const errorText = useErrorText()
  const git = createGitActions(() => props.placementId)
  const sections = createSections()
  const target = createMemo(() => compareScopeOf(review.scope()))
  const statusQuery = useQuery(() => ({ ...api.status(props.placementId), enabled: props.active }))
  const logQuery = useQuery(() => ({ ...api.log(props.placementId, GRAPH_LIMIT), enabled: props.active }))
  const compareQuery = useQuery(() => ({
    ...api.diff(props.placementId, target() ?? defaultScope),
    enabled: props.active && target() !== undefined,
  }))
  const status = () => statusQuery.data ?? EMPTY_STATUS
  const branch = () => status().branch
  const compareUrl = useCompareUrl(() => props.placementId, branch)
  const [selectedPath, setSelectedPath] = createSignal<string>()
  const activePath = () => props.activePath ?? selectedPath()
  const open = (entry: ChangeEntry, scope: DiffScope) => {
    setSelectedPath(entry.path)
    review.setScope(scope)
    props.onFileClick(entry.path)
  }
  const compareLabel = createMemo(() => {
    const scope = target()
    if (!scope) return ""
    if (scope.kind === "branchWorktree") return `${shortRef(scope.base)} → ${t("review.compare.workingTree")}`
    if (scope.kind === "branch") return `${shortRef(scope.base)} → ${branch() ?? "HEAD"}`
    const head = !scope.to || scope.to === "HEAD" ? (branch() ?? "HEAD") : shortRef(scope.to)
    return `${shortRef(scope.from)} → ${head}`
  })
  const selectedHash = () => {
    const scope = target()
    return scope?.kind === "range" ? scope.to : undefined
  }
  const selectCommit = (commit: GitCommit) =>
    review.setScope(selectedHash() === commit.hash ? defaultScope : commitScope(commit))
  const commit = async (variant: CommitVariant) => {
    const committed = await git.commit(review.message().trim(), variant === "amend")
    if (!committed) return
    review.setMessage("")
    if (variant === "commit-push") await git.push(false)
  }
  return (
    <div
      data-testid="source-control-view"
      data-pending={git.pending()}
      class="claxedo-source-control flex size-full min-h-0 flex-col"
      classList={{ "claxedo-source-control--busy": !!git.pending() }}
      aria-busy={git.pending() ? "true" : undefined}
    >
      <CommitBox
        message={review.message()}
        onMessage={review.setMessage}
        hasMessage={review.message().trim().length > 0}
        hasStaged={status().staged.length > 0}
        pending={git.pending() === "commit"}
        error={git.error() ? errorText(git.error()!) : undefined}
        onCommit={(variant) => void commit(variant)}
      />
      <PushRow
        status={status()}
        pending={git.pending() === "push"}
        compareUrl={compareUrl()}
        onPush={(setUpstream) => void git.push(setUpstream)}
      />
      <div class="flex min-h-0 flex-1 flex-col">
        <div
          data-testid="source-control-groups"
          class="min-h-0 overflow-auto"
          classList={{ "flex-1": sections.collapsed().graph, "max-h-[65%] shrink": !sections.collapsed().graph }}
        >
          <Show when={!statusQuery.isPending} fallback={<LoadingRows />}>
            <Show when={target()}>
              {(scope) => (
                <CompareGroup
                  label={compareLabel()}
                  entries={compareEntries(compareQuery.data)}
                  loading={compareQuery.isPending}
                  error={compareQuery.error ?? undefined}
                  collapsed={sections.collapsed().compare}
                  onToggle={() => sections.toggle("compare")}
                  activePath={activePath()}
                  onOpen={(entry) => open(entry, scope())}
                />
              )}
            </Show>
            <WorktreeGroups
              status={status()}
              scope={review.scope()}
              sections={sections}
              activePath={activePath()}
              pending={git.pending()}
              onStage={git.stage}
              onUnstage={git.unstage}
              onOpen={open}
            />
          </Show>
        </div>
        <CommitGraph
          commits={logQuery.data ?? []}
          loading={logQuery.isPending}
          collapsed={sections.collapsed().graph}
          onToggle={() => sections.toggle("graph")}
          selectedHash={selectedHash()}
          onSelect={selectCommit}
        />
      </div>
    </div>
  )
}
