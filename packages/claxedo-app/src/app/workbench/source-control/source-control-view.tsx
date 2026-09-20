import { errorMessage } from "@claxedo/helpers"
import { Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useSDK } from "@/app/providers/sdk/sdk"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { isRelayHostKind } from "@/platform/runtime/placement-wire"
import { workspaceDiffSummaryQueryOptions } from "@/platform/files/workspace-diff-summary-query"
import { workspaceGitLogQueryOptions, workspaceGitStatusQueryOptions } from "@/platform/files/workspace-git-status-query"
import { isWorkspaceGitError, type GitCommitSummary, type GitWorktreeStatus } from "@/platform/runtime/workspace-git-client"
import { commitReviewSelection, createReviewSelection, shortRef, type ReviewMode } from "@/features/review/review-intent"
import { createReviewDiffClient } from "@/features/review/ui/review-vcs-load"
import { useSessionParams } from "@/features/session/providers/session-params"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useWorkspaceGitMutations } from "../context/workspace-git-mutations"
import { ChangeGroup, type ChangeEntry } from "./change-group"
import { CommitBox, type CommitVariant } from "./commit-box"
import { CommitGraph } from "./commit-graph"
import { CompareGroup } from "./compare-group"
import { githubCompareUrl, githubOwnerRepo, useWorkspaceRemoteUrl } from "./workspace-remote"
import "./source-control.css"

/** The modes a Changes-column row opens: a worktree group, or the comparison above them. */
export type SourceControlReviewMode = Exclude<ReviewMode, "uncommitted">

const GRAPH_LIMIT = 50

const ERROR_KEY = {
  git_empty_message: "navigator.sourceControl.error.git_empty_message",
  git_nothing_staged: "navigator.sourceControl.error.git_nothing_staged",
  git_conflict: "navigator.sourceControl.error.git_conflict",
  git_push_rejected: "navigator.sourceControl.error.git_push_rejected",
  git_timeout: "navigator.sourceControl.error.git_timeout",
} as const

function errorKey(error: unknown) {
  if (!isWorkspaceGitError(error)) return undefined
  return Object.entries(ERROR_KEY).find(([code]) => code === error.code)?.[1]
}

const EMPTY_STATUS: GitWorktreeStatus = { ahead: 0, behind: 0, staged: [], unstaged: [] }

export function SourceControlView(props: {
  active: boolean
  activePath?: string
  onFileClick: (path: string, mode: SourceControlReviewMode) => void
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const params = useSessionParams()
  const mutations = useWorkspaceGitMutations()
  const scope = () => ({ baseUrl: sdk.url, directoryPath: sdk.directory, workspaceKey: sdk.workspaceId })
  const review = createReviewSelection({ scope: () => ({ directory: params.directory(), sessionId: params.sessionId() }) })
  const compareTarget = createMemo(() => {
    const selection = review.selection()
    if (selection.mode !== "to-from" || !selection.fromRef || !selection.toRef) return undefined
    return { mode: selection.mode, fromRef: selection.fromRef, toRef: selection.toRef }
  })

  const statusQuery = useQuery(() => ({
    ...workspaceGitStatusQueryOptions({ git: sdk.git, scope: scope() }),
    enabled: props.active,
  }))
  const logQuery = useQuery(() => ({
    ...workspaceGitLogQueryOptions({ git: sdk.git, scope: scope(), limit: GRAPH_LIMIT }),
    enabled: props.active,
  }))
  const vcsQuery = useQuery(() => {
    const workspace = sdk.workspace()
    return {
      ...workspaceVcsQuery({
        baseUrl: sdk.url,
        directory: sdk.directory,
        client: sdk.client,
        workspaceId: workspace?.workspaceId,
        workspace,
        signedControlPlane: isRelayHostKind(workspace?.kind),
      }),
      enabled: props.active,
    }
  })
  const diffClient = createMemo(() => {
    const workspace = sdk.workspace()
    return createReviewDiffClient({
      serverUrl: getClaxedoServerUrl(),
      directory: sdk.directory,
      request: platform.fetch,
      workspaceId: workspace?.workspaceId,
      workspace,
    })
  })
  const compareQuery = useQuery(() => ({
    ...workspaceDiffSummaryQueryOptions({ client: diffClient(), scope: scope(), target: compareTarget() ?? { mode: "to-from" } }),
    enabled: props.active && compareTarget() !== undefined,
  }))
  const remoteUrl = useWorkspaceRemoteUrl({
    baseUrl: () => sdk.url,
    directory: () => sdk.directory,
    workspaceId: () => sdk.workspaceId,
  })

  const status = () => statusQuery.data ?? EMPTY_STATUS
  const branch = () => status().branch ?? vcsQuery.data?.branch ?? undefined
  const commits = () => logQuery.data ?? []
  const pending = () => mutations.pending()

  const [message, setMessage] = createSignal("")
  const [error, setError] = createSignal<unknown>()
  const [collapsed, setCollapsed] = createSignal<Record<"compare" | "staged" | "changes" | "graph", boolean>>({
    compare: false,
    staged: false,
    changes: false,
    graph: true,
  })
  const toggle = (section: "compare" | "staged" | "changes" | "graph") =>
    setCollapsed((current) => ({ ...current, [section]: !current[section] }))

  const errorText = createMemo(() => {
    const value = error()
    if (value === undefined) return undefined
    const key = errorKey(value)
    if (!key) return errorMessage(value)
    return language.t(key, { message: errorMessage(value) })
  })

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await action()
      return true
    } catch (caught) {
      setError(() => caught)
      return false
    }
  }

  const commit = async (variant: CommitVariant) => {
    const text = message().trim()
    const committed = await run(() => mutations.commitStaged({ message: text, amend: variant === "amend" }))
    if (!committed) return
    setMessage("")
    if (variant === "commit-push") await run(() => mutations.push({}))
  }

  const compareUrl = createMemo(() => {
    const ownerRepo = githubOwnerRepo(remoteUrl())
    const head = branch()
    const base = vcsQuery.data?.default_branch ?? undefined
    if (!ownerRepo || !head || !base || head === base) return undefined
    return githubCompareUrl({ ownerRepo, base, head })
  })

  const hasChanges = () => status().staged.length > 0 || status().unstaged.length > 0
  // The tree owns its selection: the panel clears a file focus once it is
  // consumed, so the highlight cannot follow that one-shot request.
  const [selectedPath, setSelectedPath] = createSignal<string>()
  const activePath = () => props.activePath ?? selectedPath()
  const open = (entry: ChangeEntry, mode: SourceControlReviewMode) => {
    setSelectedPath(entry.path)
    props.onFileClick(entry.path, mode)
  }
  const compareLabel = createMemo(() => {
    const target = compareTarget()
    if (!target) return ""
    const head = target.toRef === "HEAD" ? branch() ?? "HEAD" : shortRef(target.toRef)
    return `${shortRef(target.fromRef)} → ${head}`
  })
  const selectedCommitHash = () => compareTarget()?.toRef
  const selectCommit = (commit: GitCommitSummary) => {
    review.set(selectedCommitHash() === commit.hash ? { mode: "uncommitted" } : commitReviewSelection(commit))
  }

  return (
    <div
      data-testid="source-control-view"
      data-pending={pending() ?? undefined}
      class="claxedo-source-control flex size-full min-h-0 flex-col"
      classList={{ "claxedo-source-control--busy": !!pending() }}
      aria-busy={pending() ? "true" : undefined}
    >
      <CommitBox
        message={message()}
        onMessage={setMessage}
        hasMessage={message().trim().length > 0}
        hasStaged={status().staged.length > 0}
        pending={pending() === "commit"}
        error={errorText()}
        onCommit={(variant) => void commit(variant)}
      />
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border-weak-base px-2">
        <Show
          when={status().upstream !== undefined}
          fallback={
            <ActionButton
              testId="source-control-publish"
              label={language.t("navigator.sourceControl.publish")}
              pending={pending() === "push"}
              onClick={() => void run(() => mutations.push({ setUpstream: true }))}
            />
          }
        >
          <Show
            when={status().ahead > 0}
            fallback={
              <span data-testid="source-control-up-to-date" class="px-2 text-12-regular text-text-weaker">
                {language.t("navigator.sourceControl.upToDate")}
              </span>
            }
          >
            <ActionButton
              testId="source-control-push"
              label={`${language.t("navigator.sourceControl.push")} ${status().ahead}`}
              pending={pending() === "push"}
              onClick={() => void run(() => mutations.push({}))}
            />
          </Show>
        </Show>
        <span class="flex-1" />
        <Show when={compareUrl()}>
          {(url) => (
            <Button
              as="a"
              data-testid="source-control-create-pr"
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="small"
              class="gap-1.5"
            >
              <SemanticIcon concept="pullRequest" size="small" />
              <span>{language.t("navigator.sourceControl.createPr")}</span>
            </Button>
          )}
        </Show>
      </div>
      <div class="flex min-h-0 flex-1 flex-col">
        <div
          data-testid="source-control-groups"
          class="min-h-0 overflow-auto"
          classList={{ "flex-1": collapsed().graph, "max-h-[65%] shrink": !collapsed().graph }}
        >
          <Show
            when={!statusQuery.isPending}
            fallback={
              <div data-testid="source-control-loading" aria-label={language.t("navigator.sourceControl.loading")} class="flex flex-col gap-1 p-2">
                <div class="h-6 w-[82%] rounded-md bg-surface-base" />
                <div class="h-6 w-[69%] rounded-md bg-surface-base" />
                <div class="h-6 w-[54%] rounded-md bg-surface-base" />
              </div>
            }
          >
            <Show when={compareTarget()}>
              <CompareGroup
                label={compareLabel()}
                entries={compareQuery.data}
                loading={compareQuery.isPending}
                error={compareQuery.error ?? undefined}
                collapsed={collapsed().compare}
                onToggle={() => toggle("compare")}
                activePath={activePath()}
                onOpen={(entry) => open(entry, "to-from")}
              />
            </Show>
            <ChangeGroup
              id="staged"
              entries={status().staged}
              collapsed={collapsed().staged}
              active={review.selection().mode === "staged"}
              onToggle={() => toggle("staged")}
              activePath={activePath()}
              pending={pending()}
              onAction={(paths) => void run(() => mutations.unstage(paths))}
              onOpen={(entry) => open(entry, "staged")}
            />
            <ChangeGroup
              id="changes"
              entries={status().unstaged}
              collapsed={collapsed().changes}
              active={review.selection().mode === "unstaged"}
              onToggle={() => toggle("changes")}
              activePath={activePath()}
              pending={pending()}
              onAction={(paths) => void run(() => mutations.stage(paths))}
              onOpen={(entry) => open(entry, "unstaged")}
            />
            <Show when={!hasChanges()}>
              <div data-testid="source-control-empty" class="px-3 py-2 text-12-regular text-text-weak">
                {language.t("navigator.sourceControl.empty")}
              </div>
            </Show>
          </Show>
        </div>
        <CommitGraph
          commits={commits()}
          loading={logQuery.isPending}
          collapsed={collapsed().graph}
          onToggle={() => toggle("graph")}
          selectedHash={selectedCommitHash()}
          onSelect={selectCommit}
        />
      </div>
    </div>
  )
}

function ActionButton(props: { testId: string; label: string; pending: boolean; onClick: () => void }) {
  return (
    <Button data-testid={props.testId} variant="ghost" size="small" class="gap-1.5" onClick={() => props.onClick()}>
      <Show when={props.pending} fallback={<SemanticIcon concept="push" size="small" />}>
        <Spinner class="size-3" />
      </Show>
      <span>{props.label}</span>
    </Button>
  )
}
