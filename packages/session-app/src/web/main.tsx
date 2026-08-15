/**
 * Web shell: URL → client → core → render.
 *
 *   ?server=http://127.0.0.1:PORT   local server / workspace runtime base URL
 *   &directory=/abs/path            workspace directory
 *   &session=ses_x                  optional; omitted → session picker
 *
 * Unsigned local only — no auth anywhere, matching the goal. The shell owns
 * all I/O: it loads the transcript, subscribes the runtime-event stream, and
 * executes core effects (send-prompt), feeding every outcome back into the
 * core as messages.
 */

import { render } from "@solidjs/web"
import { For, Show, createSignal } from "solid-js"
import { createLocalServerClient, type LocalServerClient, type SessionSummary } from "../client/local-server-client"
import { createComposerClient } from "../client/composer-client"
import { initSessionModel, type ComposerResource } from "../core/model"
import { runCore } from "./run-core"
import { SessionView } from "./app"
import "./styles.css"

const params = new URLSearchParams(location.search)
const serverUrl = params.get("server") ?? "http://127.0.0.1:1707"
const directory = params.get("directory") ?? ""
const sessionId = params.get("session")

const client = createLocalServerClient({ baseUrl: serverUrl })
const root = document.getElementById("root")!

if (!directory) {
  render(() => <Landing />, root)
} else if (sessionId) {
  bootSession(client, sessionId, directory)
} else {
  render(() => <SessionPicker client={client} directory={directory} />, root)
}

function bootSession(client: LocalServerClient, sessionId: string, directory: string) {
  // Fire-and-forget: on the desktop-local server this makes the directory's
  // workspace routes live before the transcript/stream requests race in.
  const resolved = client.resolveWorkspace(directory).catch(() => {})
  const composerClient = createComposerClient({ baseUrl: serverUrl })
  const fail = (dispatch: (msg: Parameters<typeof handle.dispatch>[0]) => void, resource: ComposerResource) =>
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[composer] ${resource} load failed: ${message}`)
      dispatch({ type: "ComposerLoadFailed", resource, error: message })
    }

  const handle = runCore(initSessionModel({ sessionId, directory }), (effect, dispatch) => {
    switch (effect.kind) {
      case "send-prompt":
        client
          .sendPrompt({
            sessionId: effect.sessionId,
            directory: effect.directory,
            text: effect.text,
            ...(effect.model ? { model: effect.model } : {}),
            ...(effect.agent ? { agent: effect.agent } : {}),
            ...(effect.variant ? { variant: effect.variant } : {}),
            ...(effect.permissionMode ? { permissionMode: effect.permissionMode } : {}),
          })
          .then(() => dispatch({ type: "PromptAccepted" }))
          .catch((error) => dispatch({ type: "PromptFailed", error: error instanceof Error ? error.message : String(error) }))
        break
      case "load-roster":
        composerClient
          .listHarnesses(effect.directory)
          .then((harnesses) => dispatch({ type: "RosterLoaded", harnesses }))
          .catch(fail(dispatch, "roster"))
        break
      case "load-models":
        // ACP harnesses expose models+thought-levels through harness options;
        // opencode/pi answer 404 there ("exposed through /provider") — fall
        // back to the provider catalog for those.
        composerClient
          .harnessOptions({ directory: effect.directory, harness: effect.harness })
          .then((result) => {
            if (result.models.length > 0) return { models: result.models, efforts: result.efforts }
            return composerClient
              .providerCatalog({ directory: effect.directory, harness: effect.harness })
              .then((catalog) => ({
                models: catalog.providers.flatMap((provider) => provider.models),
                efforts: [],
              }))
          })
          .catch(() =>
            composerClient
              .providerCatalog({ directory: effect.directory, harness: effect.harness })
              .then((catalog) => ({
                models: catalog.providers.flatMap((provider) => provider.models),
                efforts: [],
              })),
          )
          .then((result) =>
            dispatch({ type: "ModelsLoaded", harness: effect.harness, models: result.models, efforts: result.efforts }),
          )
          .catch(fail(dispatch, "models"))
        break
      case "load-modes":
        composerClient
          .permissionModes({ directory: effect.directory, harness: effect.harness })
          .then((result) =>
            dispatch({
              type: "ModesLoaded",
              harness: effect.harness,
              modes: result.modes,
              ...(result.currentModeId ? { currentModeId: result.currentModeId } : {}),
              ...(result.unsupported ? { unsupported: result.unsupported } : {}),
            }),
          )
          .catch(fail(dispatch, "modes"))
        break
      case "load-workspaces":
        composerClient
          .listWorkspaces()
          .then((workspaces) => dispatch({ type: "WorkspacesLoaded", workspaces }))
          .catch(fail(dispatch, "workspaces"))
        break
      case "load-worktrees":
        composerClient
          .listWorktrees(effect.directory)
          .then((worktrees) => dispatch({ type: "WorktreesLoaded", directory: effect.directory, worktrees }))
          .catch(fail(dispatch, "worktrees"))
        break
      case "create-worktree":
        composerClient
          .createWorktree({ directory: effect.directory, ...(effect.name ? { name: effect.name } : {}) })
          .then((worktree) => dispatch({ type: "WorktreeCreated", worktree }))
          .catch(fail(dispatch, "worktree-create"))
        break
    }
  })
  handle.dispatch({ type: "ComposerOpened" })

  void resolved.then(() =>
    client
      .loadTranscript(sessionId, directory)
      .then((messages) => handle.dispatch({ type: "TranscriptLoaded", messages }))
      .catch((error) => handle.dispatch({ type: "PromptFailed", error: `transcript: ${error instanceof Error ? error.message : String(error)}` })),
  )

  client.subscribeRuntimeEvents({
    directory,
    onEnvelope: (envelope) => {
      if (envelope.sessionId === sessionId) handle.dispatch({ type: "RuntimeEvent", event: envelope.payload })
    },
    onConnection: (state) => handle.dispatch({ type: "ConnectionChanged", state }),
  })

  ;(globalThis as { __model?: unknown }).__model = handle.model
  render(() => <SessionView model={handle.model} dispatch={handle.dispatch} />, root)
}

function open(session: string) {
  const next = new URLSearchParams(location.search)
  next.set("session", session)
  location.search = next.toString()
}

function SessionPicker(props: { client: LocalServerClient; directory: string }) {
  const [sessions, setSessions] = createSignal<SessionSummary[] | undefined>()
  const [error, setError] = createSignal<string>()
  props.client
    .resolveWorkspace(props.directory)
    .then(() => props.client.listSessions(props.directory))
    .then(setSessions)
    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))

  const create = async () => {
    try {
      const session = await props.client.createSession({ directory: props.directory })
      open(session.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div class="picker">
      <h1>Sessions in {props.directory}</h1>
      <Show when={error()}><div class="muted">Error: {error()}</div></Show>
      <Show when={sessions()} fallback={<div class="muted">Loading…</div>}>
        <For each={sessions()}>{(session) => (
          <button onClick={() => open(session.id)}>
            {session.title ?? session.id}
            <div class="muted">{session.id}</div>
          </button>
        )}</For>
        <button onClick={() => void create()}>+ New session</button>
      </Show>
    </div>
  )
}

function Landing() {
  return (
    <div class="picker">
      <h1>Claxedo Session</h1>
      <div class="muted">
        Pass <code>?server=http://127.0.0.1:PORT&amp;directory=/abs/path</code> to connect to a local
        Claxedo server, then pick or create a session.
      </div>
    </div>
  )
}
