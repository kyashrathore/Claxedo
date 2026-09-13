/**
 * What `createTasksSessionBridge` does on every host, as cases a host package
 * runs against its own real bridge.
 *
 * `session-bridge-core.ts` is where preview, start, adoption, handoff and
 * liveness are decided; a host supplies only the ports underneath it. Asserted
 * once per host against a fake per host, a change to the core has to be proved
 * twice and a regression the weaker fake does not model passes — so the cases
 * that belong to the core live here, and each host's own file keeps what is
 * genuinely its own: reservation and compensation for the hosted bridge,
 * embedded-runtime wiring for the local one.
 *
 * Runner-neutral like the kit's store conformance: each case is a plain async
 * function that throws, so a package registers it with its own `test`.
 */
import {
  startConfigurationDigest,
  type ConfigurationSlot,
  type Preset,
  type SessionHandoffCommand,
  type SessionOrigin,
  type SessionReference,
  type StartCommand,
  type StartPreviewCommand,
  type Task,
  type TasksActor,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"

const SLOT: ConfigurationSlot = "primary"

export type TasksSessionBridgeFixture = {
  bridge: TasksSessionBridgePort
  actor: TasksActor
  /** A task this bridge can dispatch for, naming its own workspace. */
  task: Task
  /** The workspace a task that names none is expected to start in. */
  projectWorkspaceId: string
  /** A preset whose primary configuration this host's runtime offers. */
  preset: Preset
  /** How many sessions the runtime has been asked to create. */
  creates(): number
  /** The instructions the runtime was created with, or undefined for a session it never created. */
  instructionsOf(sessionId: string): Promise<string | undefined>
  /** A session in a reachable workspace whose message history this host's runtime cannot answer for. */
  unreadableSession(): SessionReference
  /** The user message ids the runtime has been asked to run. */
  turns(): readonly string[]
  /** Marks a session archived wherever this host projects session state from. */
  archive(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

export type TasksSessionBridgeFixtureFactory = (
  input: Readonly<{ offeredModelId?: string }>,
) => Promise<TasksSessionBridgeFixture>

export type TasksSessionBridgeConformanceCase = Readonly<{ name: string; run: () => Promise<void> }>

export const TASKS_SESSION_BRIDGE_CONFORMANCE_SCOPE = {
  cases: [
    "a_stale_preview_digest_refuses_the_start",
    "a_model_the_harness_does_not_offer_blocks_the_preview",
    "a_task_with_no_workspace_preference_starts_in_its_project_s_workspace",
    "a_replayed_start_returns_the_same_session_without_creating_or_sending_again",
    "another_configuration_cannot_adopt_this_attempt_s_session",
    "an_unreadable_message_history_refuses_the_handoff_rather_than_resending",
    "liveness_and_handoff_are_read_from_the_projection_and_the_runtime",
  ],
  // NOT pinned: which session id a host mints, and where a host records
  // archival. Both are the host's, and every case above addresses a session by
  // the reference the bridge returned rather than by a shape it assumed.
} as const

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * One comparison for the whole suite, over the JSON rendering: every value a
 * case checks is a string, a number or a plain record the bridge returned, and
 * a session state read back is only ever equal in that sense.
 */
function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const [left, right] = [JSON.stringify(actual), JSON.stringify(expected)]
  if (left !== right) throw new Error(`${message}\nExpected: ${right}\nActual: ${left}`)
}

function previewCommand(
  fixture: TasksSessionBridgeFixture,
  overrides: Partial<StartPreviewCommand> = {},
): StartPreviewCommand {
  return {
    actor: fixture.actor,
    task: fixture.task,
    preset: fixture.preset,
    slot: SLOT,
    attempt: 1,
    continueFromPrevious: false,
    currentLink: null,
    currentState: null,
    authorizeTranscript: async () => true,
    ...overrides,
  }
}

async function startCommand(
  fixture: TasksSessionBridgeFixture,
  input: Readonly<{ digest: string; preset?: Preset; task?: Task }>,
): Promise<StartCommand> {
  const chosen = input.preset ?? fixture.preset
  return {
    actor: fixture.actor,
    task: input.task ?? fixture.task,
    preset: chosen,
    slot: SLOT,
    attempt: 1,
    previewDigest: input.digest,
    continueFromPrevious: false,
    clientRequestId: "req_1",
    configurationDigest: await startConfigurationDigest({ preset: chosen, slot: SLOT }),
    previousSession: null,
    authorizeTranscript: async () => true,
  }
}

function handoffCommand(fixture: TasksSessionBridgeFixture, session: SessionReference): SessionHandoffCommand {
  return {
    actor: fixture.actor,
    task: fixture.task,
    slot: SLOT,
    attempt: 1,
    handoffText: "Pick up from the failing import test.",
    session,
  }
}

/** Preview, then start what it described. Every case that needs a live session starts one this way. */
async function started(fixture: TasksSessionBridgeFixture, task?: Task): Promise<SessionReference> {
  const previewed = await fixture.bridge.preview(previewCommand(fixture, task ? { task } : {}))
  assert(previewed.ok, `preview refused: ${previewed.ok ? "" : previewed.error.message}`)
  const outcome = await fixture.bridge.start(
    await startCommand(fixture, { digest: previewed.preview.digest, ...(task ? { task } : {}) }),
  )
  assert(outcome.ok, `start refused: ${outcome.ok ? "" : outcome.error.message}`)
  return outcome.session.sessionRef
}

function attemptOrigin(fixture: TasksSessionBridgeFixture, sessionRef: SessionReference, attempt = 1): SessionOrigin {
  return { scopeId: fixture.actor.scopeId, taskId: fixture.task.id, slot: SLOT, attempt, sessionRef }
}

/**
 * A runtime may accept the handoff message before it has stored it, so the
 * state a case waits for is polled rather than read once.
 */
async function settledHandoff(
  fixture: TasksSessionBridgeFixture,
  origin: SessionOrigin,
  expected: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await fixture.bridge.sessionState([origin]))[0]
    if (state?.handoff === expected) return state.handoff
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return (await fixture.bridge.sessionState([origin]))[0]?.handoff
}

export function tasksSessionBridgeConformance(
  factory: TasksSessionBridgeFixtureFactory,
): readonly TasksSessionBridgeConformanceCase[] {
  const withFixture = async (
    input: Readonly<{ offeredModelId?: string }>,
    run: (fixture: TasksSessionBridgeFixture) => Promise<void>,
  ): Promise<void> => {
    const fixture = await factory(input)
    try {
      await run(fixture)
    } finally {
      await fixture.dispose()
    }
  }

  return [
    {
      name: "refuses a start whose preview digest no longer describes the configuration",
      run: () =>
        withFixture({}, async (fixture) => {
          const refused = await fixture.bridge.start(await startCommand(fixture, { digest: "stale" }))
          assert(!refused.ok, "a stale preview digest started a session")
          assertSameJson(refused.error.code, "conflict", "a stale preview digest was not reported as a conflict")
          assertSameJson(fixture.creates(), 0, "a refused start reached the runtime")
        }),
    },
    {
      name: "blocks a model the registered harness does not offer",
      run: () =>
        withFixture({ offeredModelId: "a-model-this-harness-does-not-offer" }, async (fixture) => {
          const previewed = await fixture.bridge.preview(previewCommand(fixture))
          assert(previewed.ok, "preview refused instead of reporting a blocker")
          assertSameJson(previewed.preview.available, false, "a model the harness does not offer previewed as available")
          assertSameJson(
            previewed.preview.blockers.map((blocker) => blocker.code),
            ["model_unavailable"],
            "the preview did not name the unavailable model",
          )
        }),
    },
    {
      name: "starts a task with no workspace preference in its project's own workspace",
      run: () =>
        withFixture({}, async (fixture) => {
          const session = await started(fixture, { ...fixture.task, workspaceId: null })
          assertSameJson(
            session.workspaceId,
            fixture.projectWorkspaceId,
            "a task with no workspace preference started somewhere else",
          )
        }),
    },
    {
      name: "a replayed start returns the same session without creating or sending again",
      run: () =>
        withFixture({}, async (fixture) => {
          const previewed = await fixture.bridge.preview(previewCommand(fixture))
          assert(previewed.ok, "preview refused")
          const command = await startCommand(fixture, { digest: previewed.preview.digest })
          const first = await fixture.bridge.start(command)
          const turns = fixture.turns().length
          const replayed = await fixture.bridge.start(command)
          assert(first.ok && replayed.ok, "a replayed start was refused")
          assertSameJson(replayed.session.sessionRef, first.session.sessionRef, "the replay answered another session")
          assertSameJson(fixture.creates(), 1, "the replay created a second session")
          assertSameJson(fixture.turns().length, turns, "the replay sent the first message again")
        }),
    },
    {
      name: "refuses to adopt the attempt's session for another configuration and leaves its instructions alone",
      run: () =>
        withFixture({}, async (fixture) => {
          const session = await started(fixture)
          const before = await fixture.instructionsOf(session.sessionId)

          const other: Preset = {
            ...fixture.preset,
            revision: fixture.preset.revision + 1,
            instructions: "Work to a different brief.",
          }
          const previewed = await fixture.bridge.preview(previewCommand(fixture, { preset: other }))
          assert(previewed.ok, "preview refused")
          const refused = await fixture.bridge.start(
            await startCommand(fixture, { digest: previewed.preview.digest, preset: other }),
          )
          assert(!refused.ok, "another configuration adopted this attempt's session")
          assertSameJson(refused.error.code, "conflict", "the refused adoption was not reported as a conflict")
          assertSameJson(
            await fixture.instructionsOf(session.sessionId),
            before,
            "the refused adoption rewrote the session's instructions",
          )
          assertSameJson(fixture.creates(), 1, "the refused adoption created a second session")
        }),
    },
    {
      name: "refuses the handoff rather than sending it when the runtime will not say whether it is already there",
      run: () =>
        withFixture({}, async (fixture) => {
          const before = fixture.turns().length
          const refused = await fixture.bridge.handoff(handoffCommand(fixture, fixture.unreadableSession()))
          assert(!refused.ok, "the handoff was sent to a session whose history could not be read")
          assertSameJson(refused.error.code, "conflict", "an unreadable history was not reported as a conflict")
          assertSameJson(fixture.turns().length, before, "the refused handoff ran a turn anyway")
        }),
    },
    {
      name: "reads liveness and handoff state from the projection and the runtime, and stores none of it",
      run: () =>
        withFixture({}, async (fixture) => {
          const live = await started(fixture)
          const origin = attemptOrigin(fixture, live)
          assertSameJson(
            await fixture.bridge.sessionState([origin]),
            [{ session: live, state: "live", handoff: "pending" }],
            "a session just started did not read as live and unhanded",
          )

          const handed = await fixture.bridge.handoff(handoffCommand(fixture, live))
          assert(handed.ok && handed.sent, "the handoff was not sent")
          assertSameJson(await settledHandoff(fixture, origin, "sent"), "sent", "the sent handoff never read as sent")
          // Another attempt's origin addresses another message id, so this
          // session is not evidence that its task was handed over.
          assertSameJson(
            await settledHandoff(fixture, attemptOrigin(fixture, live, 2), "pending"),
            "pending",
            "another attempt's origin read this session's handoff as its own",
          )

          await fixture.archive(live.sessionId)
          assertSameJson(
            await fixture.bridge.sessionState([origin]),
            [{ session: live, state: "archived", handoff: "unknown" }],
            "an archived session did not read as archived",
          )

          const absent: SessionReference = { sessionId: "ses_never_created", workspaceId: live.workspaceId }
          assertSameJson(
            await fixture.bridge.sessionState([attemptOrigin(fixture, absent)]),
            [{ session: absent, state: "deleted", handoff: "unknown" }],
            "a session the runtime never had did not read as deleted",
          )
        }),
    },
  ]
}
