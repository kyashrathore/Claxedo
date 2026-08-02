import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import {
  cloneAccessNote,
  projectRemoteCopy,
  type DerivedRemote,
  type ProjectRemoteResult,
} from "./project-remote-api"

export type ProjectRemoteSurfaceProps = {
  /** Undefined while the derivation is still running. */
  result?: ProjectRemoteResult
  loading?: boolean
  /** The remote already confirmed for this folder, if any. */
  confirmed?: DerivedRemote
  onConfirm: (remote: DerivedRemote) => void
  /** A repository URL typed by hand, for folders that derive nothing. */
  onManualUrl?: (url: string) => void
  onRetry?: () => void
}

/**
 * What a cloud sandbox would clone from the folder the user just picked.
 *
 * Deriving is a convenience and never a licence to skip confirmation — a wrong
 * guess clones the wrong codebase into a sandbox the user pays for — so an
 * origin is SHOWN and confirmed rather than adopted silently, and a folder with
 * several remotes and no origin is asked about rather than guessed at.
 *
 * Only `display` is ever rendered. The server rebuilds it from host and path so
 * an embedded credential cannot reach the screen; `url` is passed onward only.
 */
export const ProjectRemoteSurface: Component<ProjectRemoteSurfaceProps> = (props) => {
  const [manual, setManual] = createSignal("")
  const copy = createMemo(() => props.result ? projectRemoteCopy(props.result) : undefined)
  const candidates = createMemo<readonly DerivedRemote[]>(() => {
    const result = props.result
    if (result?.kind === "origin") return [result.remote]
    if (result?.kind === "ambiguous") return result.remotes
    return []
  })

  return (
    <div class="setup-block" data-component="project-remote-surface" data-kind={props.result?.kind ?? "loading"}>
      <Show when={props.loading}>
        <div class="flex items-center gap-2 text-13-regular text-text-base">
          <Spinner />
          Reading this folder's git remotes…
        </div>
      </Show>

      <Show when={copy()}>
        {(text) => <p class="text-13-regular text-text-base">{text().message}</p>}
      </Show>

      <Show when={candidates().length > 0}>
        <div class="setup-rows">
          <For each={candidates()}>
            {(remote) => (
              <div class="setup-row" data-remote={remote.name}>
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">{remote.display}</span>
                  <span class="setup-row-consequence text-12-regular">
                    {remote.name} · {cloneAccessNote(remote)}
                  </span>
                  {/* The user should know their remote carried a secret, even
                      though we never show it — it is in their git config. */}
                  <Show when={remote.credentialsStripped}>
                    <span class="setup-row-consequence text-12-regular">
                      This remote had a credential embedded in it. Claxedo removed it and never stores or shows it.
                    </span>
                  </Show>
                </span>
                <Show
                  when={props.confirmed?.url === remote.url}
                  fallback={
                    <Button size="small" variant="secondary" onClick={() => props.onConfirm(remote)}>
                      {candidates().length > 1 ? "Clone this one" : "Use this remote"}
                    </Button>
                  }
                >
                  <span class="setup-verified text-12-regular">
                    <Icon name="circle-check" size="small" />
                    Confirmed
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={copy()?.offerManualUrl && props.onManualUrl}>
        <div class="setup-block">
          <TextField
            label="Repository URL"
            value={manual()}
            placeholder="https://github.com/you/your-repo"
            onChange={(value: string) => setManual(value)}
          />
          <Button
            class="self-start"
            size="small"
            variant="secondary"
            disabled={manual().trim().length === 0}
            onClick={() => props.onManualUrl?.(manual().trim())}
          >
            Use this repository
          </Button>
        </div>
      </Show>

      <Show when={copy()?.offerRetry && props.onRetry}>
        <Button class="self-start" size="small" variant="ghost" onClick={() => props.onRetry?.()}>
          Try again
        </Button>
      </Show>
    </div>
  )
}
