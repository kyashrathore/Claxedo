import { record } from "../json"
import { BoatApiError, createBoatApi, invalid, requiredText, type BoatClientOptions } from "./boat-client"

export type BoatNamedSnapshotStatus = "saving" | "ready" | "failed"

export type BoatNamedSnapshot = { name: string; status: BoatNamedSnapshotStatus; createdAt: string }

export type BoatSnapshotShare = { id: string; status: "active" | "revoked"; createdAt: string }

const STATUSES: ReadonlySet<string> = new Set(["saving", "ready", "failed"])

function namedSnapshot(value: unknown): BoatNamedSnapshot {
  const snapshot = record(value) ?? invalid()
  const status = requiredText(snapshot.status)
  if (!STATUSES.has(status)) invalid()
  return { name: requiredText(snapshot.name), status: status as BoatNamedSnapshotStatus, createdAt: requiredText(snapshot.createdAt) }
}

function share(value: unknown): BoatSnapshotShare {
  const entry = record(value) ?? invalid()
  const status = requiredText(entry.status)
  if (status !== "active" && status !== "revoked") invalid()
  return { id: requiredText(entry.id), status, createdAt: requiredText(entry.createdAt) }
}

function list<T>(value: unknown, item: (entry: unknown) => T) {
  return Array.isArray(value) ? value.map(item) : invalid()
}

/** Boat's named snapshots and their share codes (docs.boat.dev/snapshots/templates). */
export function createBoatNamedSnapshotClient(options: BoatClientOptions) {
  const api = createBoatApi(options)
  const path = (name: string) => `/named-snapshots/${encodeURIComponent(name)}`
  return {
    /** A stopped sandbox is saved from its last snapshot; the save settles in the background. */
    async save(input: { sandboxId: string; name: string }) {
      return namedSnapshot((await api("/named-snapshots", ["snapshot.named.saving"], { method: "POST", body: input })).snapshot)
    },
    async get(name: string): Promise<BoatNamedSnapshot | undefined> {
      try {
        return namedSnapshot((await api(path(name), ["snapshot.named.info"])).snapshot)
      } catch (err) {
        if (err instanceof BoatApiError && err.status === 404) return undefined
        throw err
      }
    },
    /** Newest first. */
    async list() {
      return list((await api("/named-snapshots", ["snapshot.named.list"])).snapshots, namedSnapshot)
    },
    async delete(name: string) {
      await api(path(name), ["snapshot.named.deleted"], { method: "DELETE" })
    },
    /** Boat shows the code only in this answer and keeps a hash of it. */
    async share(name: string) {
      const body = await api(`${path(name)}/shares`, ["snapshot.share.created"], { method: "POST" })
      return { shareCode: requiredText(body.shareCode), share: share(body.share) }
    },
    async shares(name: string) {
      return list((await api(`${path(name)}/shares`, ["snapshot.share.list"])).shares, share)
    },
    async revokeShare(name: string, shareId: string) {
      await api(`${path(name)}/shares/${encodeURIComponent(shareId)}`, ["snapshot.share.revoked"], { method: "DELETE" })
    },
  }
}
