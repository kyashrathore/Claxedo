import type { PluginManifest, PluginPermission } from "@claxedo/plugin-api"
import type { MarketplaceKey } from "../i18n"
import type { AppPluginCatalog, AppPluginInstall, AppPluginListing } from "@/server"
import type { Phrase, PluginStatus } from "../model"

export type AppPluginEntry = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly manifest: PluginManifest
  readonly listing?: AppPluginListing
  readonly install?: AppPluginInstall
}

export type AppPluginMainAction = "install" | "turnOn" | "turnOff" | "turnOnForOrganization"

function byName(left: AppPluginEntry, right: AppPluginEntry) {
  return left.name.localeCompare(right.name)
}

function entryOf(listing: AppPluginListing | undefined, install: AppPluginInstall | undefined): AppPluginEntry | undefined {
  const manifest = install?.manifest ?? listing?.manifest
  if (!manifest) return undefined
  return {
    id: manifest.id,
    name: install?.manifest.name ?? listing?.name ?? manifest.id,
    ...(listing?.description ? { description: listing.description } : {}),
    manifest,
    ...(listing ? { listing } : {}),
    ...(install ? { install } : {}),
  }
}

export function appPluginEntries(installs: readonly AppPluginInstall[], catalog: AppPluginCatalog | undefined): readonly AppPluginEntry[] {
  const listings = new Map((catalog?.plugins ?? []).map((listing) => [listing.id, listing]))
  const installed = installs.flatMap((install) => entryOf(listings.get(install.id), install) ?? []).sort(byName)
  const ids = new Set(installs.map((install) => install.id))
  const available = [...listings.values()].filter((listing) => !ids.has(listing.id)).flatMap((listing) => entryOf(listing, undefined) ?? []).sort(byName)
  return [...installed, ...available]
}

export function appPluginUpdate(entry: AppPluginEntry): string | undefined {
  const { install, listing } = entry
  if (!install || !listing) return undefined
  return listing.versions.indexOf(install.version) > 0 ? listing.latest : undefined
}

export function appPluginStatus(entry: AppPluginEntry): PluginStatus | undefined {
  const { install } = entry
  if (!install) return entry.listing?.available === false ? { key: "marketplace.app.status.unavailable", tone: "warning", attention: false } : undefined
  if (!install.active) return { key: "marketplace.app.status.organizationOff", tone: "warning", attention: false }
  if (appPluginUpdate(entry)) return { key: "marketplace.status.updateAvailable", tone: "accent", attention: false }
  return install.enabledForMe
    ? { key: "marketplace.app.status.on", tone: "normal", attention: false }
    : { key: "marketplace.app.status.off", tone: "normal", attention: false }
}

export function appPluginMainAction(entry: AppPluginEntry, canManage: boolean): AppPluginMainAction | undefined {
  const { install } = entry
  if (!install) return canManage && entry.listing?.available !== false ? "install" : undefined
  if (!install.active) return canManage ? "turnOnForOrganization" : undefined
  return install.enabledForMe ? "turnOff" : "turnOn"
}

const PERMISSION_PROMPTS: Readonly<Record<PluginPermission, MarketplaceKey>> = {
  "projects.read": "marketplace.app.permission.projectsRead",
  "sessions.read": "marketplace.app.permission.sessionsRead",
  "sessions.start": "marketplace.app.permission.sessionsStart",
  "workspaces.cloud": "marketplace.app.permission.workspacesCloud",
  tools: "marketplace.app.permission.tools",
  blobs: "marketplace.app.permission.blobs",
  events: "marketplace.app.permission.events",
  schedule: "marketplace.app.permission.schedule",
  links: "marketplace.app.permission.links",
  "session-files": "marketplace.app.permission.sessionFiles",
}

export function appPluginAccess(manifest: PluginManifest): readonly Phrase[] {
  return [
    { key: "marketplace.app.access.frame" },
    ...(manifest.backend ? [{ key: "marketplace.app.access.backend" } as const] : []),
    ...(manifest.permissions ?? []).map((permission): Phrase => ({ key: PERMISSION_PROMPTS[permission] })),
    ...(manifest.backend?.outbound ?? []).map((host): Phrase => ({ key: "marketplace.app.access.outbound", params: { host } })),
    ...manifest.server.routes.map((route): Phrase => ({ key: "marketplace.app.access.route", params: { route } })),
    ...manifest.server.operations.map((operation): Phrase => ({ key: "marketplace.app.access.operation", params: { operation } })),
  ]
}

export function matchesAppPlugin(entry: AppPluginEntry, query: string): boolean {
  if (!query) return true
  return [entry.name, entry.id, entry.description ?? ""].join(" ").toLowerCase().includes(query)
}
