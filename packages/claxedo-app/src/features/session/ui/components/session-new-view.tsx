// Claxedo keeps the upstream empty-session summary while resolving project display across cloud workspace refs.
import { Show, createMemo, createResource, type JSX } from "solid-js"
import { DateTime } from "luxon"
import { useSDK } from "@/features/session/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { getFilename } from "@/lib/path"
import { ClaxedoLogo } from "@/ui/controls/claxedo-logo"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useQuery } from "@tanstack/solid-query"
import { queryClient } from "@/platform/query/query-client"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { newSessionProjectRoot } from "@/features/session/ui/components/session-new-view-root"
import { directorySessionCacheQueryOptions } from "../../data/sync/queries"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const ROOT_CLASS = "size-full flex flex-col"

type ProjectInventoryItem = {
  id: string
  worktree: string
  time: {
    created: number
    updated?: number
  }
  sandboxes?: string[]
  workspaces?: Record<string, unknown>
}

type SessionGitMetadata = {
  git?: {
    remote?: string
  }
}

function parseOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote) return
  // git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const ssh = remote.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/)
  if (ssh?.[1]) return ssh[1]
  return
}

/**
 * `variant` controls the empty-session chrome:
 *  - `"full"`    – logo, title, project path, branch, last-modified (default, main session page)
 *  - `"compact"` – title only, no project details (embedded panels / split views)
 *  - `"hidden"`  – renders nothing (review / page docks where the prompt alone is enough)
 */
export type NewSessionVariant = "full" | "compact" | "hidden"

interface NewSessionViewProps {
  worktree: string
  onWorktreeChange: (value: string) => void
  /** Controls how much chrome to show. Defaults to `"full"`. */
  variant?: NewSessionVariant
  /** Override the title text. */
  title?: string
  /** Replace the entire empty-state content. */
  children?: JSX.Element
}

export function NewSessionView(props: NewSessionViewProps) {
  const variant = () => props.variant ?? "full"

  if (variant() === "hidden") return null

  const sdk = useSDK()
  const language = useLanguage()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())

  const inventoryProjects = createMemo(() => (projectsQuery.data ?? []) as ProjectInventoryItem[])
  const activeProject = createMemo(() => {
    const selection = props.worktree === MAIN_WORKTREE || props.worktree === CREATE_WORKTREE ? sdk.directory : props.worktree
    return inventoryProjects().find((project) =>
      project.worktree === sdk.directory ||
      project.sandboxes?.includes(sdk.directory) ||
      sdk.directory in (project.workspaces ?? {}) ||
      project.worktree === selection ||
      project.sandboxes?.includes(selection) ||
      selection in (project.workspaces ?? {}),
    )
  })
  const sandboxes = createMemo(() => activeProject()?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => newSessionProjectRoot({
    sdkDirectory: sdk.directory,
    projectWorktree: activeProject()?.worktree,
  }))
  const [vcsInfo] = createResource(
    projectRoot,
    async (directory) =>
      queryClient.fetchQuery(workspaceVcsQuery({
        baseUrl: sdk.url,
        directory,
        client: sdk.createClient({ directory }),
      })).catch(() => undefined),
  )
  const directorySessionCacheQuery = useQuery(() =>
    directorySessionCacheQueryOptions({
      directory: projectRoot(),
    }),
  )
  const projectDisplayName = createMemo(() => {
    const remote = directorySessionCacheQuery.data?.session
      .map((session) => (session as SessionGitMetadata).git?.remote)
      .find((item) => !!item)
    const ownerRepo = parseOwnerRepo(remote)
    if (ownerRepo) return ownerRepo
    return getFilename(projectRoot())
  })
  const isWorktree = createMemo(() => {
    const project = activeProject()
    if (!project) return false
    return sdk.directory !== project.worktree
  })

  const label = (value: string) => {
    if (value === MAIN_WORKTREE) {
      if (isWorktree()) return language.t("session.new.worktree.main")
      const branch = vcsInfo()?.branch
      if (branch) return language.t("session.new.worktree.mainWithBranch", { branch })
      return language.t("session.new.worktree.main")
    }

    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")

    return getFilename(value)
  }

  const titleText = () => props.title ?? language.t("session.new.title")

  // Custom children replace the entire content area
  if (props.children !== undefined) {
    return (
      <div class={ROOT_CLASS}>
        <div class="flex-1 flex items-center justify-center text-center p-6">
          {props.children}
        </div>
      </div>
    )
  }

  // Compact variant: just logo + title, no project details
  if (variant() === "compact") {
    return (
      <div class={ROOT_CLASS}>
        <div class="flex-1 flex items-center justify-center text-center p-6">
          <div class="flex flex-col items-center gap-4">
            <ClaxedoLogo class="w-8 opacity-20" />
            <div class="text-14-medium text-text-weak">{titleText()}</div>
            <div class="flex items-center gap-1.5 text-12-medium text-text-weak select-text leading-5">
              <Icon name="folder" size="small" class="shrink-0 opacity-60" />
              <span class="text-text-strong">{projectDisplayName()}</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Full variant: logo, title, project path, branch, last modified
  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          <div class="flex flex-col items-center gap-6">
            <ClaxedoLogo class="w-10" />
            <div class="text-20-medium text-text-strong">{titleText()}</div>
          </div>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-center justify-center gap-1.5 min-h-5">
              <Icon name="folder" size="small" class="shrink-0 text-text-weak" />
              <div class="text-12-medium text-text-strong select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {projectDisplayName()}
              </div>
            </div>
            <div class="flex items-start justify-center gap-1.5 min-h-5">
              <Icon name="branch" size="small" class="mt-0.5 shrink-0" />
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {label(current())}
              </div>
            </div>
            <Show when={activeProject()}>
              {(project) => (
                <div class="flex items-start justify-center gap-3 min-h-5">
                  <div class="text-12-medium text-text-weak leading-5 min-w-0 max-w-160 break-words text-center">
                    {language.t("session.new.lastModified")}&nbsp;
                    <span class="text-text-strong">
                      {DateTime.fromMillis(project().time.updated ?? project().time.created)
                        .setLocale(language.intl())
                        .toRelative()}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
