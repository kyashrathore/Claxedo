import type { BackgroundWork } from "@claxedo/agent-runtime-contract"
import type { AppError } from "./types"

export type RetryAction = {
  readonly reason: string
  readonly provider: string
  readonly title: string
  readonly message: string
  readonly label: string
  readonly link?: string
}

export type { BackgroundWork }

export type SessionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "retrying"; readonly message: string; readonly attempt?: number; readonly nextAt?: number; readonly action?: RetryAction }
  | { readonly kind: "interrupted"; readonly message?: string }
  | { readonly kind: "failed"; readonly error: AppError }
  | { readonly kind: "runningInBackground" }

export type ListedStatus = { readonly status: SessionStatus; readonly waitingOnUser: boolean; readonly backgroundWork: BackgroundWork }

export type BackgroundTaskStop = { readonly ok: true } | { readonly ok: false; readonly status: "not_found"; readonly message: string }
