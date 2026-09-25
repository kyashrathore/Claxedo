import type { AppError } from "@/server"

export type LiveListState =
  | { readonly kind: "notOffered" }
  | { readonly kind: "loading" }
  | { readonly kind: "listed" }
  | { readonly kind: "notOwner" }
  | { readonly kind: "failed"; readonly reason: string }

export type LiveListRead = { readonly offered: boolean; readonly listed: boolean; readonly error: AppError | null }

export function liveListState(read: LiveListRead): LiveListState {
  if (!read.offered) return { kind: "notOffered" }
  if (read.error?.class === "auth") return { kind: "notOwner" }
  if (read.error) return { kind: "failed", reason: read.error.message }
  return read.listed ? { kind: "listed" } : { kind: "loading" }
}
