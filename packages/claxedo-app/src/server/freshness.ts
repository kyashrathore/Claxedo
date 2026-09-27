import type { ServerEvent } from "./events"
import type { queryKeys } from "./query-keys"

export type Freshness =
  | { readonly kind: "event-owned"; readonly events: readonly ServerEvent["type"][] }
  | { readonly kind: "ttl"; readonly ms: number; readonly reason: string }
  | { readonly kind: "once"; readonly reason: string }

type InvalidationPrefix = "filesAll" | "filesOf" | "gitAll" | "gitOf" | "usageAll" | "marketplaceAll" | "codeHostAll" | "providerCatalogs"

export type CacheName = Exclude<keyof typeof queryKeys, InvalidationPrefix>

const catalogEvents = ["projectChanged", "placementsChanged", "cloudWorkspaceChanged", "streamGap"] as const
const placementEvents = ["placementsChanged", "cloudWorkspaceChanged", "streamGap"] as const
const placementFileEvents = ["filesChanged", "statusChanged", "streamGap"] as const

const catalog: Freshness = { kind: "event-owned", events: catalogEvents }
const placementOwned: Freshness = { kind: "event-owned", events: placementEvents }
const fileOwned: Freshness = { kind: "event-owned", events: placementFileEvents }

export const freshness = {
  bootstrap: catalog,
  accountCatalog: placementOwned,
  projects: catalog,
  project: catalog,
  placements: catalog,
  placementsOf: catalog,
  machines: placementOwned,
  cloud: placementOwned,
  livePlugins: { kind: "event-owned", events: ["pluginsChanged"] },
  usage: { kind: "event-owned", events: ["usageChanged"] },
  fileTree: fileOwned,
  fileContent: fileOwned,
  fileSearch: fileOwned,
  gitStatus: fileOwned,
  gitLog: fileOwned,
  gitRefs: fileOwned,
  gitBases: fileOwned,
  gitDiff: fileOwned,
  gitDiffFile: fileOwned,
  accounts: { kind: "once", reason: "accounts change only through this app's account and provider-connect writes, which invalidate the list" },
  accountsEffective: { kind: "once", reason: "under the accounts prefix, so every account write refreshes it with the list" },
  machineLogins: { kind: "once", reason: "a login scan starts each harness CLI; it is re-read only by an explicit check or rescan, which write the result" },
  marketplace: { kind: "once", reason: "the plugin catalog changes through this app's installs, removals and activations, which invalidate every catalog" },
  marketplaceSources: { kind: "once", reason: "plugin sources change through this app's source writes, which invalidate the list" },
  marketplaceSkill: { kind: "once", reason: "a skill document changes only with its plugin; nothing in this app refreshes it after the first read" },
  marketplaceMachine: { kind: "once", reason: "the machine-installed list is read once; a plugin install through this app does not invalidate it" },
  tasks: { kind: "once", reason: "whether the server offers the tasks route is a capability that does not change within an app life" },
  tasksAll: { kind: "once", reason: "task, preset and capability reads under this prefix are refreshed by this app's own task commands" },
  folderPaths: { kind: "once", reason: "the folder picker's starting paths are read once; nothing in this app refreshes them" },
  folderChildren: { kind: "once", reason: "the folder picker lists a directory once; a folder created outside the app is missed until restart" },
  harnessOptions: { kind: "once", reason: "a harness's agent and model options for a placement are read once; nothing in this app refreshes them" },
  integrations: { kind: "once", reason: "the integration catalog changes through this app's connects and disconnects, which invalidate it" },
  agentConnections: { kind: "once", reason: "agent connections change through this app's removals, which invalidate the list" },
  sandboxProviders: { kind: "once", reason: "the sandbox provider catalog changes through this app's key saves, which write the result" },
  providerAuth: { kind: "once", reason: "the connect form forces a fresh read each time it opens with staleTime 0; otherwise the auth methods are static" },
  providerCatalog: { kind: "once", reason: "a harness's provider catalog is invalidated by this app's provider connects and filled in by detail loads" },
  codeHostRepositories: { kind: "once", reason: "under the codeHost prefix, refreshed by this app's integration connects and disconnects" },
} satisfies Record<CacheName, Freshness>
