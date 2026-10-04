import type { ServerEvent } from "./events"
import type { queryKeys } from "./query-keys"

export type Freshness =
  | { readonly kind: "event-owned"; readonly events: readonly ServerEvent["type"][] }
  | { readonly kind: "ttl"; readonly ms: number; readonly reason: string }
  | { readonly kind: "once"; readonly reason: string }

type CachePrefix = "filesAll" | "filesOf" | "gitAll" | "gitOf" | "usageAll" | "marketplaceAll" | "codeHostAll" | "providerCatalogs"

export type CacheName = Exclude<keyof typeof queryKeys, CachePrefix>

const catalogEvents = ["projectChanged", "placementsChanged", "cloudWorkspaceChanged", "streamGap"] as const
const placementEvents = ["placementsChanged", "cloudWorkspaceChanged", "streamGap"] as const
const placementFileEvents = ["filesChanged", "statusChanged", "streamGap"] as const

const catalog: Freshness = { kind: "event-owned", events: catalogEvents }
const placementOwned: Freshness = { kind: "event-owned", events: placementEvents }
const fileOwned: Freshness = { kind: "event-owned", events: placementFileEvents }

export const freshness = {
  bootstrap: catalog,
  accountCatalog: placementOwned,
  sharedSessions: { kind: "event-owned", events: ["sessionsChanged", "streamGap"] },
  projects: catalog,
  project: catalog,
  placements: catalog,
  placementsOf: catalog,
  machines: placementOwned,
  organizations: { kind: "once", reason: "membership changes only through an invitation or an admin, neither of which this app does; the next sign-in reads it again" },
  organizationMembers: { kind: "once", reason: "read when the Organization section opens; membership changes happen elsewhere" },
  cloud: placementOwned,
  livePlugins: { kind: "event-owned", events: ["pluginsChanged"] },
  usage: { kind: "event-owned", events: ["usageChanged"] },
  fileTree: fileOwned,
  fileContent: fileOwned,
  localFilesAll: { kind: "once", reason: "the desktop file prefix configures gcTime 0; each artifact is read afresh when its tab mounts" },
  outsideFileContent: { kind: "once", reason: "files outside a workspace are re-read on every file-tab mount with staleTime 0 and gcTime 0; no workspace event owns them" },
  fileSearch: fileOwned,
  gitStatus: fileOwned,
  gitLog: fileOwned,
  gitRefs: fileOwned,
  gitBases: fileOwned,
  gitDiff: fileOwned,
  gitDiffFile: fileOwned,
  terminalAgents: { kind: "once", reason: "the agent CLIs installed in a workspace image do not change while the app runs" },
  accounts: { kind: "once", reason: "accounts change only through this app's account and provider-connect writes, which invalidate the list" },
  accountsEffective: { kind: "once", reason: "under the accounts prefix, so every account write refreshes it with the list" },
  machineLogins: { kind: "once", reason: "a login scan starts each harness CLI; it is re-read only by an explicit check or rescan, which write the result" },
  accountSources: { kind: "once", reason: "under the accounts prefix, so every account write, a source choice included, refreshes it with the list" },
  sandboxKeys: { kind: "once", reason: "under the accounts prefix, so saving, checking, removing a sandbox key or choosing the default refreshes it with the list" },
  marketplace: { kind: "once", reason: "the plugin catalog changes through this app's installs, removals and activations, which invalidate every catalog" },
  marketplaceSources: { kind: "once", reason: "plugin sources change through this app's source writes, which invalidate the list" },
  marketplaceSkill: { kind: "once", reason: "a skill document changes only with its plugin; nothing in this app refreshes it after the first read" },
  tasks: { kind: "once", reason: "whether the server offers the tasks route is a capability that does not change within an app life" },
  tasksAll: { kind: "once", reason: "task, preset and capability reads under this prefix are refreshed by this app's own task commands" },
  folderPaths: { kind: "once", reason: "the folder picker's starting paths are read once; nothing in this app refreshes them" },
  folderChildren: { kind: "once", reason: "the folder picker lists a directory once; a folder created outside the app is missed until restart" },
  harnessOptions: { kind: "once", reason: "a harness's agent and model options for a placement are read once; nothing in this app refreshes them" },
  harnessCommands: { kind: "once", reason: "a harness's saved and declared commands for a placement are read once; nothing in this app refreshes them" },
  stopsBackgroundTasks: { kind: "once", reason: "whether a session's harness stops one background task is fixed by its harness; the read waits for a running background task" },
  integrations: { kind: "once", reason: "the integration catalog changes through this app's connects and disconnects, which invalidate it" },
  agentConnections: { kind: "once", reason: "agent connections change through this app's removals, which invalidate the list" },
  providerAuth: { kind: "once", reason: "the connect form forces a fresh read each time it opens with staleTime 0; otherwise the auth methods are static" },
  providerCatalog: { kind: "once", reason: "a harness's provider catalog is invalidated by this app's provider connects and filled in by detail loads" },
  codeHostRepositories: { kind: "once", reason: "under the codeHost prefix, refreshed by this app's integration connects and disconnects" },
} satisfies Record<CacheName, Freshness>
