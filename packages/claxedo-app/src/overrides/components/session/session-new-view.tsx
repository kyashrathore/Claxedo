import { Show, createMemo, createResource, type JSX } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"
import { getFilename } from "@opencode-ai/util/path"
import { ClaxedoLogo } from "@claxedo/claxedo-ui/components/claxedo-logo"
import { useGlobalSync } from "@opencode-ai/claxedo-app"
import { queryClient } from "../../../shared/query/query-client"
import { workspaceVcsQuery } from "../../../shared/query/runtime"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const ROOT_CLASS = "size-full flex flex-col"

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

  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const sandboxes = createMemo(() => sync.project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const [vcsInfo] = createResource(
    projectRoot,
    async (directory) =>
      queryClient.fetchQuery(workspaceVcsQuery({
        baseUrl: sdk.url,
        directory,
        client: sdk.createClient({ directory }),
      })),
  )
  const projectDisplayName = createMemo(() => {
    const projectId = sync.project?.id
    if (projectId) {
      const sessions = globalSync.globalSessions.store.byProject[projectId]
      const remote = sessions?.find((s) => s.git?.remote)?.git?.remote
      const ownerRepo = parseOwnerRepo(remote)
      if (ownerRepo) return ownerRepo
    }
    return getFilename(projectRoot())
  })
  const isWorktree = createMemo(() => {
    const project = sync.project
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
            <Show when={sync.project}>
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
