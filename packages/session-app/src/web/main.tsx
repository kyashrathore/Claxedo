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
import { initSessionModel } from "../core/model"
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
  const handle = runCore(initSessionModel({ sessionId, directory }), (effect, dispatch) => {
    if (effect.kind === "send-prompt") {
      client
        .sendPrompt({ sessionId: effect.sessionId, directory: effect.directory, text: effect.text })
        .then(() => dispatch({ type: "PromptAccepted" }))
        .catch((error) => dispatch({ type: "PromptFailed", error: error instanceof Error ? error.message : String(error) }))
    }
  })

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
