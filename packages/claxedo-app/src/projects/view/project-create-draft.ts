import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { createFlow, runFlow } from "@/lib/flow"
import { codeHostConnections, codeHostIntegrations, toAppError, useServer, type ProjectSource } from "@/server"

export type SourceMode = "folder" | "repository"
type RepositoryEntry = "list" | "url"
export type RepositoryView = "checking" | "url" | "connect" | "list" | "failed"

export type ProjectCreateDraftOptions = {
  readonly folderMachine: Accessor<string | undefined>
  readonly pickFolder?: () => Promise<string | undefined>
  readonly send: (source: ProjectSource, name: string | undefined) => Promise<void>
}

function createRepositoryChoice(active: Accessor<boolean>) {
  const server = useServer()
  const connectionsServed = () => server.capabilities()?.features.connections === true
  const offered = useQuery(() => ({ ...server.queries.integrations.codeHosts(), enabled: active() && connectionsServed() }))
  const integration = () => codeHostIntegrations(offered.data)[0]
  const usable = createMemo(() => codeHostConnections(offered.data).filter((connection) => connection.status !== "broken"))
  const [chosenId, setChosenId] = createSignal<string>()
  const connection = createMemo(() => usable().find((item) => item.id === chosenId()) ?? usable()[0])
  const [entry, setEntry] = createSignal<RepositoryEntry>("list")
  const view = (): RepositoryView => {
    if (!connectionsServed()) return "url"
    if (offered.isPending) return "checking"
    if (offered.error) return "failed"
    if (!integration()) return "url"
    if (entry() === "url") return "url"
    return connection() ? "list" : "connect"
  }
  const repositories = useQuery(() => {
    const id = connection()?.id ?? ""
    return { ...server.queries.codeHost.repositories(id), enabled: active() && view() === "list" && id !== "" }
  })
  const switchable = () => integration() !== undefined
  return { integration, usable, connection, setChosenId, entry, setEntry, view, repositories, switchable, error: () => offered.error, retry: () => offered.refetch() }
}

export type RepositoryChoice = ReturnType<typeof createRepositoryChoice>

function createSourcePick(options: ProjectCreateDraftOptions) {
  const [folder, setFolder] = createSignal("")
  const [repoUrl, setRepoUrl] = createSignal("")
  const [source, setSource] = createSignal<SourceMode>("folder")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const offersFolder = () => options.folderMachine() !== undefined && Boolean(options.pickFolder)
  const mode = (): SourceMode => (offersFolder() ? source() : "repository")
  const choice = createRepositoryChoice(() => mode() === "repository")
  const chosen = (): ProjectSource | undefined => {
    if (mode() === "folder") return folder() ? { kind: "folder", path: folder() } : undefined
    const connection = choice.connection()
    if (choice.view() === "list") return connection && selected() ? { kind: "connectedRepository", connectionId: connection.id, fullName: selected() ?? "" } : undefined
    if (choice.view() !== "url") return undefined
    return repoUrl().trim() ? { kind: "repository", url: repoUrl().trim() } : undefined
  }
  const chooseFolder = async () => {
    const picked = await options.pickFolder?.()
    if (picked) setFolder(picked)
  }
  return { folder, repoUrl, setRepoUrl, setSource, query, setQuery, selected, setSelected, offersFolder, mode, choice, chosen, chooseFolder }
}

export function createProjectCreateDraft(options: ProjectCreateDraftOptions) {
  const pick = createSourcePick(options)
  const [name, setName] = createSignal("")
  const sending = createFlow<"sending", void>()
  const busy = () => sending.state().kind === "running"
  const error = () => {
    const state = sending.state()
    return state.kind === "failed" ? state.error.message : undefined
  }
  const clearError = () => {
    if (sending.state().kind === "failed") sending.send({ type: "reset" })
  }
  const submit = async () => {
    const picked = pick.chosen()
    if (!picked || busy()) return
    await runFlow(sending, "sending", () => options.send(picked, name().trim() || undefined), toAppError)
  }
  const editUrl = (url: string) => {
    clearError()
    pick.setRepoUrl(url)
  }
  const chooseSource = (next: SourceMode) => {
    clearError()
    pick.setSource(next)
  }
  return { ...pick, folderMachine: options.folderMachine, name, setName, editUrl, chooseSource, busy, error, submit }
}

export type ProjectCreateDraft = ReturnType<typeof createProjectCreateDraft>
