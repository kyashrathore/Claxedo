import { Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useSDK } from "@/app/providers/sdk/sdk"
import { useLanguage } from "@/platform/i18n/provider"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { isRelayBackedWorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { workspaceGitLogQueryOptions, workspaceGitStatusQueryOptions } from "@/platform/files/workspace-git-status-query"
import { isWorkspaceGitError, type GitStatusEntry, type GitWorktreeStatus } from "@/platform/runtime/workspace-git-client"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useWorkspaceGitMutations } from "../context/workspace-git-mutations"
import { ChangeGroup } from "./change-group"
import { CommitBox, type CommitVariant } from "./commit-box"
import { CommitGraph } from "./commit-graph"
import { githubCompareUrl, githubOwnerRepo, useWorkspaceRemoteUrl } from "./workspace-remote"
import "./source-control.css"

export type SourceControlReviewMode = "staged" | "unstaged"

const GRAPH_LIMIT = 50

const ERROR_KEY = {
  git_empty_message: "navigator.sourceControl.error.git_empty_message",
  git_nothing_staged: "navigator.sourceControl.error.git_nothing_staged",
  git_conflict: "navigator.sourceControl.error.git_conflict",
  git_push_rejected: "navigator.sourceControl.error.git_push_rejected",
} as const

function errorKey(error: unknown) {
  if (!isWorkspaceGitError(error)) return undefined
  return Object.entries(ERROR_KEY).find(([code]) => code === error.code)?.[1]
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const EMPTY_STATUS: GitWorktreeStatus = { ahead: 0, behind: 0, staged: [], unstaged: [] }

export function SourceControlView(props: {
  active: boolean
  activePath?: string
  onFileClick: (path: string, mode: SourceControlReviewMode) => void
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const mutations = useWorkspaceGitMutations()
  const scope = () => ({ baseUrl: sdk.url, directoryPath: sdk.directory, workspaceKey: sdk.workspaceId })

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
        signedControlPlane: isRelayBackedWorkspaceKind(workspace?.kind),
      }),
      enabled: props.active,
    }
  })
  const remoteUrl = useWorkspaceRemoteUrl({
    baseUrl: () => sdk.url,
    directory: () => sdk.directory,
    workspaceId: () => sdk.workspaceId,
  })

  const status = () => statusQuery.data ?? EMPTY_STATUS
  const commits = () => logQuery.data ?? []
  const pending = () => mutations.pending()

  const [message, setMessage] = createSignal("")
  const [error, setError] = createSignal<unknown>()
  const [collapsed, setCollapsed] = createSignal<Record<"staged" | "changes" | "graph", boolean>>({
    staged: false,
    changes: false,
    graph: false,
  })
  const toggle = (section: "staged" | "changes" | "graph") =>
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
    const branch = status().branch ?? vcsQuery.data?.branch ?? undefined
    const base = vcsQuery.data?.default_branch ?? undefined
    if (!ownerRepo || !branch || !base || branch === base) return undefined
    return githubCompareUrl({ ownerRepo, base, head: branch })
  })

  const hasChanges = () => status().staged.length > 0 || status().unstaged.length > 0
  const open = (entry: GitStatusEntry, mode: SourceControlReviewMode) => props.onFileClick(entry.path, mode)

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
              <span data-testid="source-control-up-to-date" class="text-11-regular text-text-weaker">
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
            <a
              data-testid="source-control-create-pr"
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              class="claxedo-source-control-link flex h-6 items-center gap-1 rounded px-1.5 text-11-regular text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base"
            >
              <SemanticIcon concept="pullRequest" size="small" />
              <span>{language.t("navigator.sourceControl.createPr")}</span>
            </a>
          )}
        </Show>
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
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
          <ChangeGroup
            id="staged"
            entries={status().staged}
            collapsed={collapsed().staged}
            onToggle={() => toggle("staged")}
            activePath={props.activePath}
            pending={pending()}
            onAction={(paths) => void run(() => mutations.unstage(paths))}
            onOpen={(entry) => open(entry, "staged")}
          />
          <ChangeGroup
            id="changes"
            entries={status().unstaged}
            collapsed={collapsed().changes}
            onToggle={() => toggle("changes")}
            activePath={props.activePath}
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
        <CommitGraph
          commits={commits()}
          loading={logQuery.isPending}
          collapsed={collapsed().graph}
          onToggle={() => toggle("graph")}
        />
      </div>
    </div>
  )
}

function ActionButton(props: { testId: string; label: string; pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      class="flex h-6 items-center gap-1 rounded px-1.5 text-11-regular text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base"
      onClick={() => props.onClick()}
    >
      <Show when={props.pending} fallback={<SemanticIcon concept="push" size="small" />}>
        <Spinner class="size-3" />
      </Show>
      <span>{props.label}</span>
    </button>
  )
}
