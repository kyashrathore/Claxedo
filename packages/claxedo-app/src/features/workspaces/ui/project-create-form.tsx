import { createEffect, createMemo, createSignal, For, getOwner, onCleanup, runWithOwner, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import type { CodeHostIntegration, CodeHostRepositoryList, CodeHostRequest, CodeHostStatus } from "@/features/onboarding/code-host-api"
import { createIntegrationsRequest } from "@/platform/account/integrations-request"
import {
  connectCodeHost,
  connectedCodeHosts,
  listCodeHostRepositories,
  readCodeHostAttempt,
  readCodeHostStatus,
} from "../app-ports"
import { createProject, projectRequestMessage, type ProjectRecord, type ProjectSource } from "../data/project-api"

/**
 * Create a project: where its repository is, nothing else.
 *
 * A project is a repository and a name; where it executes is a workspace,
 * chosen later in the composer's Environment and Workspace chips, and the
 * name is the server's to derive from the source. So this form asks one
 * question. The repository is a folder already on this machine — offered
 * only when the server has a filesystem, picked through the server's
 * directory browser — or a repository the server clones: one of the
 * connected code host's, chosen from its list, or a pasted URL, the only
 * path that clones anonymously.
 *
 * One component, two hosts: the composer's Project chip renders it in the
 * chip's panel and the first-run wizard renders it as the screen. A host
 * that has no project route (the hosted plane) takes the choice through
 * `onSubmit` instead of letting the form post it.
 */
export function ProjectCreateForm(
  props: {
    baseUrl?: string
    /**
     * `compact` fits a chip popover; `comfortable` fills a host that sets its
     * own width, with fields large enough to be the screen's subject.
     */
    size?: "compact" | "comfortable"
    /** Whether this server runs projects on its own filesystem (offers the folder source). */
    localExecution: boolean
    /** Opens the server's directory browser; resolves to the chosen absolute path. */
    pickFolder?: () => Promise<string | undefined>
    initial?: { folder?: string }
    /**
     * The `/api/claxedo/integrations` request that answers which code host is
     * connected. Defaults to the app's own dual-path client for `baseUrl`.
     */
    codeHost?: CodeHostRequest
    /**
     * Handed the control that leads the form whenever one mounts (the folder
     * button, or the URL or search field where there is no folder), so a
     * host can put focus on it.
     */
    leadField?: (element: HTMLElement) => void
    onCancel?: () => void
  } & (
    | {
        /** The host holds the choice; nothing is posted. */
        onSubmit: (source: ProjectSource) => void | Promise<void>
        submitLabel?: string
        onCreated?: undefined
      }
    | { onSubmit?: undefined; onCreated: (project: ProjectRecord) => void }
  ),
) {
  const [folder, setFolder] = createSignal(props.initial?.folder ?? "")
  const [repoUrl, setRepoUrl] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [source, setSource] = createSignal<"folder" | "repository">("folder")
  const [entry, setEntry] = createSignal<"list" | "url">("list")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()

  const offersFolder = () => props.localExecution && Boolean(props.pickFolder)
  const mode = () => (offersFolder() ? source() : "repository")

  const codeHost = createMemo(() => props.codeHost ?? createIntegrationsRequest(props.baseUrl))
  // Signals rather than resources: a resource suspends every `Suspense` above
  // it, and this form is the no-project screen under the shell's own boundary,
  // so a code-host read that hangs would hold the whole app on its fallback.
  const [status, setStatus] = createSignal<CodeHostStatus>()
  const [checking, setChecking] = createSignal(false)
  const [repositories, setRepositories] = createSignal<CodeHostRepositoryList>()
  const [listing, setListing] = createSignal(false)
  const settled = <T,>(read: () => Promise<T>, apply: (value: T | undefined) => void, busy: (value: boolean) => void) => {
    let current = true
    onCleanup(() => {
      current = false
    })
    busy(true)
    void read()
      .then((value) => current && apply(value))
      .catch(() => current && apply(undefined))
      .finally(() => current && busy(false))
  }
  const refetchStatus = () => settled(() => readCodeHostStatus(codeHost()), setStatus, setChecking)
  // The first switch to a repository reads the code host and the answer is
  // kept: a read per switch blanks the panel to "Checking…" on every toggle.
  // The read belongs to the form, not the effect, so switching back to the
  // folder while it is in flight does not discard it.
  const owner = getOwner()
  let statusRequested = false
  createEffect(() => {
    if (mode() !== "repository" || statusRequested) return
    statusRequested = true
    runWithOwner(owner, refetchStatus)
  })
  const integration = () => status()?.integrations[0]
  const connection = () => {
    const current = status()
    return current ? connectedCodeHosts(current)[0] : undefined
  }
  createEffect(() => {
    const connectionId = connection()?.id
    if (!connectionId) return
    settled(() => listCodeHostRepositories(codeHost(), connectionId), setRepositories, setListing)
  })
  const repositoryView = (): "checking" | "url" | "connect" | "list" => {
    if (checking()) return "checking"
    if (!integration() || entry() === "url") return "url"
    return connection() ? "list" : "connect"
  }

  const chosen = (): ProjectSource | undefined => {
    if (mode() === "folder") return folder() ? { kind: "directory", folder: folder() } : undefined
    if (repositoryView() === "list") {
      const connectionId = connection()?.id
      const fullName = selected()
      return connectionId && fullName ? { kind: "repository", connectionId, repo: { fullName } } : undefined
    }
    if (repositoryView() !== "url") return undefined
    return repoUrl().trim() ? { kind: "repository", repoUrl: repoUrl().trim() } : undefined
  }
  const canSubmit = () => !busy() && Boolean(chosen())
  const switchSource = () => {
    setError("")
    setSource(source() === "folder" ? "repository" : "folder")
  }

  const submit = async (event: Event) => {
    event.preventDefault()
    const picked = chosen()
    if (!picked || !canSubmit()) return
    setBusy(true)
    setError("")
    try {
      if (props.onSubmit) {
        await props.onSubmit(picked)
        return
      }
      props.onCreated(await createProject({ baseUrl: props.baseUrl, source: picked }))
    } catch (cause) {
      setError(projectRequestMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async () => {
    const picked = await props.pickFolder?.()
    if (picked) setFolder(picked)
  }

  const comfortable = () => props.size === "comfortable"
  const control = (): "normal" | "small" => (comfortable() ? "normal" : "small")
  const label = () =>
    comfortable()
      ? "text-[length:var(--font-size-intermediate)] font-medium text-text-weak"
      : "text-12-medium text-text-weak"
  const box = () =>
    comfortable()
      ? "h-10 rounded-lg border border-border-base bg-surface-inset-base px-3"
      : "h-8 rounded-md border border-border-base bg-surface-inset-base px-2.5"
  const field = () =>
    `${box()} w-full min-w-0 ${comfortable() ? "text-14-regular" : "text-13-regular"} text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`
  const hint = () => (comfortable() ? "text-12-regular text-text-weak" : "text-11-regular text-text-weak")
  const link = () =>
    `${comfortable() ? "text-12-medium" : "text-11-medium"} text-text-weak underline-offset-2 hover:text-text-strong hover:underline focus-visible:underline focus-visible:outline-none`
  const submitLabel = () => {
    if (props.onSubmit) return props.submitLabel ?? "Continue"
    return busy() ? "Creating…" : "Create project"
  }

  const UrlField = () => (
    <label class="flex flex-col gap-1">
      <span class={label()}>Repository URL</span>
      <input
        type="text"
        value={repoUrl()}
        onInput={(event) => setRepoUrl(event.currentTarget.value)}
        placeholder="https://github.com/owner/repo"
        aria-label="Repository URL"
        spellcheck={false}
        class={field()}
        ref={(element) => props.leadField?.(element)}
      />
      <span class={hint()}>
        <Show
          when={integration()}
          fallback="This server offers no code host to choose from, so the repository is cloned by URL."
        >
          {(host) => `Cloned on this server. A private ${host().name} repository clones with the connected account.`}
        </Show>
      </span>
    </label>
  )

  return (
    <form
      onSubmit={(event) => void submit(event)}
      class={comfortable() ? "flex w-full flex-col gap-4" : "flex w-[340px] max-w-full flex-col gap-3"}
      data-slot="project-create-form"
    >
      <Show when={offersFolder()}>
        <div class="-mb-2 flex justify-end">
          <button type="button" data-slot="project-create-source" class={link()} onClick={switchSource}>
            {mode() === "folder" ? "Clone a repository instead" : "Select a folder instead"}
          </button>
        </div>
      </Show>

      <Show
        when={mode() === "folder"}
        fallback={
          <div class="flex flex-col gap-3">
            <Show when={repositoryView() === "checking"}>
              <span class={hint()}>Checking connected accounts…</span>
            </Show>
            <Show when={repositoryView() === "connect" ? integration() : undefined}>
              {(host) => (
                <ConnectBlock
                  integration={host()}
                  request={codeHost()}
                  comfortable={comfortable()}
                  onConnected={refetchStatus}
                />
              )}
            </Show>
            <Show when={repositoryView() === "list"}>
              <RepositoryList
                list={repositories()}
                loading={listing()}
                query={query()}
                onQuery={setQuery}
                selected={selected()}
                onSelect={setSelected}
                comfortable={comfortable()}
                leadField={props.leadField}
              />
            </Show>
            <Show when={repositoryView() === "url"}>
              <UrlField />
            </Show>
            <Show when={integration()}>
              {(host) => (
                <button
                  type="button"
                  data-slot="project-create-url-link"
                  class={`${link()} self-start`}
                  onClick={() => {
                    setError("")
                    setEntry(entry() === "url" ? "list" : "url")
                  }}
                >
                  {entry() === "url" ? `Choose from ${host().name}` : "Paste a URL instead"}
                </button>
              )}
            </Show>
          </div>
        }
      >
        <div class="flex flex-col gap-1">
          <span class={label()}>Folder</span>
          <button
            type="button"
            aria-label="Choose folder"
            title={folder() || undefined}
            class={`${box()} flex w-full min-w-0 items-center gap-2 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none`}
            onClick={() => void chooseFolder()}
            ref={(element) => props.leadField?.(element)}
          >
            <Icon name="folder" size="small" class="shrink-0 text-icon-weak-base" />
            <Show
              when={folder()}
              fallback={
                <span class={`min-w-0 flex-1 truncate ${comfortable() ? "text-14-regular" : "text-13-regular"} text-text-weak/60`}>
                  Choose a folder…
                </span>
              }
            >
              <span
                class={`min-w-0 flex-1 truncate font-mono text-text-strong ${comfortable() ? "text-13-regular" : "text-12-regular"}`}
                data-slot="project-create-folder"
              >
                {folder()}
              </span>
            </Show>
            <span class={`shrink-0 ${comfortable() ? "text-12-medium" : "text-11-medium"} text-text-weak`}>
              {folder() ? "Change" : "Browse"}
            </span>
          </button>
          <span class={hint()}>Runs on this machine or in a cloud sandbox; you choose when you start work.</span>
        </div>
      </Show>

      <Show when={error()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {error()}
        </p>
      </Show>

      <div class="flex justify-end gap-2 pt-1">
        <Show when={props.onCancel}>
          <Button type="button" variant="ghost" size={control()} onClick={() => props.onCancel?.()}>
            Cancel
          </Button>
        </Show>
        <Button type="submit" variant="primary" size={control()} disabled={!canSubmit()}>
          {submitLabel()}
        </Button>
      </div>
    </form>
  )
}

/** How long a device code stays valid — GitHub's is 15 minutes. */
const DEVICE_GRANT_LIFETIME_MS = 15 * 60 * 1000

type PendingGrant = { url: string; attemptId: string; userCode?: string; intervalMs?: number }

/**
 * Connects the code host inline: a device grant when the host offers one
 * (the code the user types is shown before the page opens, because the page
 * cannot be completed without it), else a pasted token.
 */
function ConnectBlock(props: {
  integration: CodeHostIntegration
  request: CodeHostRequest
  comfortable: boolean
  onConnected: () => void
}) {
  const [secret, setSecret] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [grant, setGrant] = createSignal<PendingGrant>()

  const usesOAuth = () => props.integration.methods.includes("oauth")
  const prompt = () => props.integration.prompts.find((item) => item.secret) ?? props.integration.prompts[0]

  onCleanup(() => setGrant(undefined))

  async function connect(method: "oauth" | "key") {
    setBusy(true)
    setFailure(undefined)
    const outcome = await connectCodeHost({
      request: props.request,
      integrationId: props.integration.id,
      method,
      ...(method === "key" ? { secret: secret() } : {}),
    })
    if (!outcome.ok) {
      setBusy(false)
      setFailure(outcome.reason)
      return
    }
    if ("oauth" in outcome && outcome.oauth) {
      setGrant(outcome.oauth)
      void awaitApproval(outcome.oauth)
      return
    }
    setBusy(false)
    setSecret("")
    props.onConnected()
  }

  /**
   * A device grant has no callback, so the only way to learn the user
   * approved it is to keep asking, at the interval the host asked for (each
   * read advances the grant server-side). Bounded to the code's lifetime: a
   * grant the user walks away from is never answered by the host either.
   */
  async function awaitApproval(pending: PendingGrant) {
    const interval = pending.intervalMs ?? 5000
    const maxPolls = Math.ceil(DEVICE_GRANT_LIFETIME_MS / interval)
    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise<void>((resolve) => setTimeout(resolve, interval))
      if (grant()?.attemptId !== pending.attemptId) return
      const outcome = await readCodeHostAttempt(props.request, pending.attemptId)
      if (grant()?.attemptId !== pending.attemptId) return
      if (outcome.state === "pending") continue
      setGrant(undefined)
      setBusy(false)
      if (outcome.state === "failed") {
        setFailure(outcome.reason)
        return
      }
      props.onConnected()
      return
    }
    if (grant()?.attemptId !== pending.attemptId) return
    setGrant(undefined)
    setBusy(false)
    setFailure("That code expired before it was approved. Start again to get a new one.")
  }

  const text = () => (props.comfortable ? "text-13-regular" : "text-12-regular")
  const box = () =>
    props.comfortable
      ? "h-10 rounded-lg border border-border-base bg-surface-inset-base px-3 text-14-regular"
      : "h-8 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular"

  return (
    <div class="flex flex-col gap-2" data-slot="project-create-connect">
      <span class={`${text()} text-text-weak`}>
        Connect {props.integration.name} to choose one of your repositories, including private ones.
      </span>
      <Show
        when={grant()}
        fallback={
          <Show
            when={usesOAuth()}
            fallback={
              <div class="flex flex-col gap-2">
                <input
                  type={prompt()?.secret ? "password" : "text"}
                  value={secret()}
                  onInput={(event) => setSecret(event.currentTarget.value)}
                  placeholder={prompt()?.placeholder ?? prompt()?.label}
                  aria-label={prompt()?.label ?? `${props.integration.name} token`}
                  autocomplete="off"
                  spellcheck={false}
                  class={`${box()} w-full min-w-0 text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size={props.comfortable ? "normal" : "small"}
                  class="self-start"
                  disabled={busy() || !secret().trim()}
                  onClick={() => void connect("key")}
                >
                  {busy() ? "Connecting…" : `Connect ${props.integration.name}`}
                </Button>
              </div>
            }
          >
            <Button
              type="button"
              variant="secondary"
              size={props.comfortable ? "normal" : "small"}
              class="self-start"
              disabled={busy()}
              onClick={() => void connect("oauth")}
            >
              {busy() ? "Connecting…" : `Connect ${props.integration.name}`}
            </Button>
          </Show>
        }
      >
        {(pending) => (
          <div class={`flex flex-col gap-1 ${text()} text-text-base`}>
            <Show when={pending().userCode}>
              {(code) => (
                <span>
                  Enter <span class="font-mono text-text-strong" data-slot="project-create-user-code">{code()}</span> at
                </span>
              )}
            </Show>
            <a href={pending().url} target="_blank" rel="noreferrer" class="underline underline-offset-2 text-text-strong">
              {pending().url}
            </a>
            <span class="text-text-weak">Waiting for approval…</span>
          </div>
        )}
      </Show>
      <Show when={failure()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {failure()}
        </p>
      </Show>
    </div>
  )
}

/** The connected account's repositories, searched by full name; one row is the choice. */
function RepositoryList(props: {
  list: CodeHostRepositoryList | undefined
  loading: boolean
  query: string
  onQuery: (query: string) => void
  selected: string | undefined
  onSelect: (fullName: string) => void
  comfortable: boolean
  leadField?: (element: HTMLElement) => void
}) {
  const matches = createMemo(() => {
    const outcome = props.list
    if (!outcome?.ok) return []
    const needle = props.query.trim().toLowerCase()
    return needle
      ? outcome.repositories.filter((repository) => repository.fullName.toLowerCase().includes(needle))
      : outcome.repositories
  })
  const failure = () => (props.list && !props.list.ok ? props.list.reason : undefined)

  const box = () =>
    props.comfortable
      ? "h-10 rounded-lg border border-border-base bg-surface-inset-base px-3 text-14-regular"
      : "h-8 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular"
  const row = () => (props.comfortable ? "text-13-regular" : "text-12-regular")

  return (
    <div class="flex flex-col gap-2">
      <input
        type="search"
        value={props.query}
        onInput={(event) => props.onQuery(event.currentTarget.value)}
        placeholder="Search repositories"
        aria-label="Search repositories"
        autocomplete="off"
        spellcheck={false}
        data-slot="project-create-repository-search"
        class={`${box()} w-full min-w-0 text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`}
        ref={(element) => props.leadField?.(element)}
      />
      <div
        role="radiogroup"
        aria-label="Repositories"
        data-slot="project-create-repository-list"
        class={`flex max-h-56 flex-col overflow-y-auto rounded-md border border-border-base ${props.comfortable ? "max-h-72" : ""}`}
      >
        <Show when={props.loading}>
          <span class={`px-2.5 py-2 ${row()} text-text-weak`}>Loading repositories…</span>
        </Show>
        <Show when={failure()}>
          <p class={`px-2.5 py-2 ${row()} text-icon-warning-base`} role="alert">
            {failure()}
          </p>
        </Show>
        <Show when={props.list?.ok && matches().length === 0}>
          <span class={`px-2.5 py-2 ${row()} text-text-weak`}>
            {props.query.trim() ? "No repository matches." : "This account has no repositories."}
          </span>
        </Show>
        <For each={matches()}>
          {(repository) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.selected === repository.fullName}
              data-slot="project-create-repository"
              class={`flex items-center gap-2 px-2.5 py-1.5 text-left ${row()} text-text-strong hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover focus-visible:outline-none aria-checked:bg-surface-raised-base-active`}
              onClick={() => props.onSelect(repository.fullName)}
            >
              <span class="min-w-0 flex-1 truncate">{repository.fullName}</span>
              <Show when={repository.private}>
                <span class="shrink-0 rounded-sm border border-border-base px-1 text-10-medium text-text-weak">private</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
