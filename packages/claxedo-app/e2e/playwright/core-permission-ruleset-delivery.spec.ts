/**
 * SPEC: "Approve for me" delivers a permission ruleset to the opencode engine
 *
 * PURPOSE — the composer's "Approve for me" switch used to be purely local: Claxedo
 * kept ANSWERING the harness's permission prompts on the user's behalf, forever, one
 * prompt at a time. That is invisible to the engine — the grant does not exist anywhere,
 * so it dies the moment Claxedo is not there to answer, and the engine keeps spending a
 * round-trip asking about `read` on every single tool call. On an **opencode** session the
 * switch now additionally TELLS THE ENGINE: it writes a session-scoped permission ruleset
 * so the engine stops asking at all. This spec owns that write — that it happens, what is
 * in it, that turning the switch back off withdraws it, and that it happens on exactly the
 * surfaces where there is something to write to and nowhere else.
 *
 * It deliberately does NOT own the local auto-answer behaviour (Claxedo replying to a
 * `permission.asked` event), which is unchanged and older than this feature — see OUT OF
 * SCOPE.
 *
 * STATE MODEL —
 *   The switch's own state is `permission.autoAccept[key]` in the global `permission.v3`
 *   persisted store (`src/features/session/providers/permission.tsx`), keyed per
 *   session+directory for a real session and per DIRECTORY for a draft
 *   (`acceptKey` / `directoryAcceptKey`). `createComposerAutoAccept`
 *   (`src/features/session/composer/auto-accept.ts`) is the read/write pair behind the
 *   control and resolves BOTH halves against the same scope, so the control can never
 *   read one scope and toggle another.
 *   The ENGINE-side state is a `PermissionRule[]` persisted on the opencode session row,
 *   written by `PATCH /session/:sessionID` with body `{ permission }`
 *   (`applyPermissionMode`, `src/features/session/permission/apply.ts`). Two properties of
 *   that store drive every assertion below:
 *     (a) the engine's handler MERGES (`Permission.merge(current, incoming)`) rather than
 *         replacing, and NO endpoint deletes rules — so a grant can only ever be revoked
 *         by a LATER rule, never removed;
 *     (b) evaluation takes the LAST matching rule, so ordering is semantic: the catch-all
 *         must come first and the specific rules after it, and a later `ask` beats an
 *         earlier `allow`.
 *   Nothing about the write survives in the client: it is fire-and-forget with respect to
 *   the local flip (`deliverNative` is `void`-ed), and it takes effect at the START OF THE
 *   NEXT TURN, because `runLoop` snapshots the session row once at turn entry.
 *
 * ANATOMY —
 *   `[data-action="prompt-permission-mode"]` — the picker (`permission-control.tsx`). A `<button>`
 *     with `role="switch"`, `aria-checked` reflecting the local state, and
 *     `aria-label="Approve for me"` (`prompt.action.approveForMe`). Rendered only while
 *     the transport reports the `permissions` capability; `disabled` outside normal
 *     composer mode and while a harness is still applying.
 *   The write itself has no DOM surface at all — the only observable is the request, which
 *     is why this spec asserts on `mock.requests.sessionUpdateBodies` (the recorder for
 *     `PATCH /session/:sessionID`, distinct from `configPatchBodies`, which is
 *     `PATCH /session/:sessionID/config`).
 *   A FAILED write surfaces as an error toast (`onDeliveryError` in `composer.tsx`) — not
 *     covered here, see OUT OF SCOPE.
 *
 *   INCOMING CONTROL SWAP — `composer/ui/permission-control.tsx` (a `MenuV2` picker) is
 *   authored but NOT yet wired into `composer/ui/toolbar-controls.tsx`, which still renders
 *   `PromptPermissionControl`. So `[data-action="prompt-permission-mode"]` is the only permission
 *   control reachable in the DOM today and every test below drives it. When the picker is
 *   wired, the swap is confined to `approveSwitch`/`setApprove`: open
 *   `[data-action="prompt-permission-mode"]` (its `data-mode` carries the selected mode id)
 *   and click the row `[data-mode="claxedo-allow-safe"]`. Every REQUEST-BODY assertion below is
 *   unaffected — the delivery is the same `PATCH /session/:sessionID`.
 *   Two things the picker adds that this spec does NOT yet cover, because they have no DOM
 *   surface until it is wired: (a) selecting a `[data-selectable="false"]` row must issue
 *   NO request at all (the picker's central honesty property — a mode Claxedo cannot
 *   deliver must never look applied; every Claude/Codex/ACP mode is in that state today),
 *   and (b) the picker has no "off" position of its own, so the withdrawal ruleset that
 *   behavior 4 pins needs a named trigger in the new control before it can be driven
 *   through the picker rather than the switch.
 *
 * BEHAVIORS —
 *   1. Turning the switch ON for an existing **opencode** session issues exactly one
 *      `PATCH /session/:sessionID`, addressed to that session's id, whose body carries a
 *      `permission` array of `{permission, pattern, action}` rules and nothing else.
 *   2. That ruleset's FIRST entry is the catch-all `{permission:"*", pattern:"*",
 *      action:"ask"}`, and `*` appears only there — every grant is positioned after it, so
 *      last-match evaluation lands on the specific rule rather than the catch-all.
 *   3. In that ruleset the read/interactive/in-project-write permissions resolve to
 *      `allow`, the danger-gated ones (`bash`, `webfetch`, `websearch`,
 *      `external_directory`, `task`, `skill`, `doom_loop`) resolve to `ask`, every rule is
 *      tool-wide (`pattern: "*"`), and nothing is ever `deny`.
 *   4. Turning the switch back OFF issues a SECOND write that withdraws the grants: every
 *      permission the ON write allowed reappears as an EXPLICIT `ask` (not merely covered
 *      by the catch-all), and the withdrawal contains no `allow` at all. This is the only
 *      possible revocation given STATE MODEL (a) — without it the switch would be one-way
 *      and the engine would stay permissive while the UI reads "off".
 *   5. On a non-opencode harness (asserted for one ACP harness and one native-SDK harness)
 *      toggling the switch issues NO session write at all — Claxedo answers locally
 *      instead. Proven with a live positive control: a real send after the toggle is
 *      observed on the wire while the ruleset recorder stays empty.
 *   6. On a DRAFT (no session id yet) toggling issues no write either — there is no session
 *      to scope a ruleset to. The pending preference is also not smuggled into the
 *      subsequent `POST /session` body when the draft is finally sent.
 *
 * INVARIANTS —
 *   - Tier M (e2e/INVARIANTS.md #6): every route is mocked by `installMockRuntime`; zero
 *     real network.
 *   - Authoring rule #1: the `PATCH /session/:sessionID` recorder lives in the SHARED
 *     `mock-runtime.ts` (`requests.sessionUpdateBodies`), not in a spec-local
 *     `page.route`, so every spec gets it.
 *   - Authoring rule #3: no negative is proven by sleeping. Every "no write happened"
 *     assertion is paired with (i) the switch's own `aria-checked` flip, which proves the
 *     toggle handler actually ran rather than the click missing, and (ii) a request that
 *     DID reach the mock after the toggle, which proves the app was live and the recorder
 *     was watching.
 *   - The ruleset is asserted by PROPERTY, never as a frozen array literal: a future safe
 *     addition to a tier must not fail this spec. What is pinned is the catch-all's
 *     position, the closed `allow`/`ask` action vocabulary, the effective (last-match)
 *     action of each named permission, and — for behavior 4 — that the withdrawal covers
 *     exactly whatever the enable write allowed, read back off the wire rather than
 *     re-declared here.
 *   - Cross-cutting #1 (harness ownership): the harness under test is asserted positively
 *     from the composer's own harness control before the switch is touched, so a
 *     "no write on this harness" test can never pass because the harness silently failed
 *     to resolve.
 *
 * HARNESS NOTES — the write exists for `opencode` ONLY, because it is the only harness
 *   whose permission mechanism is a per-session rule list (`PERMISSION_MECHANISMS`,
 *   `src/features/session/permission/mechanisms.ts`). `claxedoAutoRevoke` returns
 *   `undefined` for every other harness, and `claxedoAutoMode(harness).delivery` for them
 *   is either a local auto-answer (ACP, cursor-sdk, pi) or a native mode/policy the
 *   composer's delivery path deliberately does not send from this control (claude-sdk,
 *   codex-app-server) — so `deliverNative` returns before any request in both directions.
 *   Behavior 5 samples `claude-acp` (ACP, local-answer delivery) and `claude-sdk` (native
 *   SDK mode delivery) — the two structurally different non-opencode outcomes.
 *
 * KNOWN FAILURE (behavior 5, both harnesses, as of this spec landing) — the app DOES write
 *   an opencode ruleset to a Claude session today. Reproduced three independent ways
 *   (direct navigation to an existing session, draft→send handoff, and after a full reload
 *   with the created row in the session-list cache), so it is not a mock artifact. Root
 *   cause: `createComposerAutoAccept` takes its harness from `currentHarnessType`
 *   (`src/features/session/composer/harness-mode-helpers.ts:31`), which for a session-mode
 *   composer returns `sessionHarness(ref).id` and therefore `"opencode"` whenever the
 *   composer's `SessionRef` carries no `harness` — while the toolbar's harness control,
 *   fed by `harnessSelectionController`, correctly reads "Claude" on the same screen. Two
 *   harness sources, out of sync; the permission delivery reads the wrong one.
 *   The test is left FAILING deliberately rather than weakened, skipped, or deleted: the
 *   behaviour it asserts is the specified one, and the write it observes is wrong on any
 *   reading. Do not "fix" it by relaxing the assertion — fix the harness resolution, or
 *   file it in `docs/e2e-decisions.md` §1 for an owner call like every other
 *   real-product-bug failure in this suite.
 *
 * OUT OF SCOPE — Claxedo's LOCAL auto-answering of `permission.asked` events and the
 *   `permissions.autoaccept` command/keybinding (`core-session-actions`); the permission
 *   mode PICKER and its harness-native deliveries (claude-sdk permission modes, codex
 *   approval policies, ACP `session/set_mode`), none of which this control touches; the
 *   failed-write error toast; the engine actually honouring the ruleset, which no mocked
 *   tier can prove — see this spec's returned findings on Tier L feasibility; session
 *   rename/archive, the OTHER writers of `PATCH /session/:sessionID`
 *   (`core-session-actions`).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS, _evidencePathForTest } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-permission-ruleset-delivery"
const SESSION_ID = "ses_core_permission_ruleset"

/** Every permission that must be reachable without a prompt once Auto is on. */
const EXPECT_ALLOWED = ["read", "grep", "question", "edit", "todowrite"] as const
/**
 * Every permission that must STILL prompt. Enumerated in full deliberately: a key
 * quietly leaving this tier is a security regression, not a refactor. Adding a NEW
 * danger key does not break this list (it would also be `ask`).
 */
const EXPECT_GATED = ["bash", "webfetch", "websearch", "external_directory", "task", "skill", "doom_loop"] as const

type Rule = { permission: string; pattern: string; action: string }

/**
 * The action the ENGINE would resolve for `permission`, i.e. the LAST matching rule —
 * see STATE MODEL (b). Asserting on this rather than on "some rule says allow" is what
 * makes the ordering claims meaningful: a ruleset that says `allow` at index 3 and `ask`
 * at index 9 grants nothing, and only a last-match reader notices.
 */
function effectiveAction(rules: readonly Rule[], permission: string): string | undefined {
  return rules.filter((rule) => rule.permission === permission).at(-1)?.action
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    // Guarded, not unconditional: `addInitScript` re-runs on every navigation, and the
    // draft→session handoff in behaviors 5/6 navigates mid-test. An unconditional
    // `localStorage.clear()` would wipe the very `permission.v3` autoAccept entry the
    // switch just wrote.
    if (sessionStorage.getItem("core-permission-ruleset-seeded")) return
    sessionStorage.setItem("core-permission-ruleset-seeded", "1")
    localStorage.clear()
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** An ALREADY-CREATED session, so `resolvedSessionId()` is set from the first paint and
 * the switch has something to scope a ruleset to without a create/navigate handoff
 * first (`GET /session/:id` in the mock always resolves). */
async function openExistingSession(page: Page, dir: string, sessionId: string) {
  await page.goto(`/${slug(dir)}/session/${sessionId}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** The permission-mode picker trigger, with its DOM contract (ANATOMY) asserted so the
 * tests below cannot be silently clicking something else.
 *
 * This replaced a binary switch. The delivery under test is unchanged — same PATCH,
 * same rulesets — but the control is now a menu, so "on/off" is expressed as a
 * SELECTED MODE (`data-mode`) rather than `aria-checked`. Auto is the former on;
 * Manual is the former off, and it is a real mode rather than an absence. */
async function approveSwitch(page: Page): Promise<Locator> {
  const control = page.locator('[data-action="prompt-permission-mode"]').last()
  await expect(control).toBeVisible({ timeout: 20_000 })
  await expect(control).toHaveAttribute("aria-label", "Approve for me")
  await expect(control).toBeEnabled({ timeout: 20_000 })
  return control
}

/**
 * Flips the switch to `next` and waits for `aria-checked` to agree.
 *
 * The pre-condition assertion matters as much as the post: it pins the direction the
 * toggle handler will compute (`enabling = !currentlyActive()`), so a test that expects a
 * grant cannot accidentally be asserting on a withdrawal. The post-condition is the
 * DETERMINISTIC proof that the handler ran — required by authoring rule #3 for every
 * negative below, since "no request arrived" is worthless if the click never landed.
 */
async function setApprove(page: Page, control: Locator, next: boolean) {
  // Claxedo's option ids, renamed from claxedo-auto/claxedo-manual when the picker
  // moved to naming options for what they DO. The rename is the whole reason these
  // assertions drifted: nothing in the unit suite reads a `data-mode` attribute.
  const from = next ? "claxedo-ask-always" : "claxedo-allow-safe"
  const to = next ? "claxedo-allow-safe" : "claxedo-ask-always"
  // Pre-condition, same purpose as before: it pins which direction the handler will
  // compute, so a test expecting a grant cannot accidentally assert on a withdrawal.
  await expect(control).toHaveAttribute("data-mode", from, { timeout: 20_000 })
  await control.click()
  const row = page.locator(`[data-mode="${to}"][data-selectable="true"]`).last()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  // Post-condition: DETERMINISTIC proof the handler ran, which every negative test
  // below depends on — "no request arrived" proves nothing if the click never landed.
  await expect(control).toHaveAttribute("data-mode", to, { timeout: 20_000 })
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

/** Evidence for the two tests whose claim is a REQUEST rather than a rendered reply, so
 * the oracle (which is about assistant text) does not apply — same directory convention
 * (`test-results/evidence/<spec>/<scenario>.png`, INVARIANTS.md authoring rule #5). */
async function captureSwitchEvidence(page: Page, scenario: string) {
  await page.screenshot({
    path: _evidencePathForTest({ spec: "core-permission-ruleset-delivery", scenario }, process.cwd()),
  })
}

/** The one shared shape assertion: the recorded body is a ruleset write and nothing else. */
function rulesetOf(
  bodies: readonly { sessionID: string; body: Record<string, unknown>; permission: Rule[] | undefined }[],
  index: number,
  expectedSessionId: string,
): Rule[] {
  const write = bodies[index]
  expect(write, `expected a PATCH /session/:id at index ${index}, saw ${bodies.length} write(s)`).toBeDefined()
  if (!write) throw new Error("unreachable")
  expect(write.sessionID, "the ruleset was written to the wrong session").toBe(expectedSessionId)
  // The delivery is a ruleset write, not a rename riding along with one: `permission`
  // is the ONLY key. (`applyPermissionMode` deliberately sends no `directory` either —
  // the client is already directory-scoped.)
  expect(Object.keys(write.body).sort()).toEqual(["permission"])
  expect(write.permission, "body.permission was absent or not an array of {permission,pattern,action}").toBeDefined()
  return write.permission ?? []
}

test.describe("core permission ruleset delivery @core", () => {
  test("enabling Approve for me on an opencode session writes the Auto ruleset — behaviors 1,2,3", async ({ page }) => {
    await seedOneProject(page, DIR)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "opencode" })

    await openExistingSession(page, DIR, SESSION_ID)
    // Cross-cutting #1: the harness is opencode, asserted positively — otherwise
    // behavior 5's negative twin could pass for the wrong reason and this one could
    // fail for the wrong reason.
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]').last()).toBeVisible({ timeout: 20_000 })

    const control = await approveSwitch(page)
    expect(mock.requests.sessionUpdateBodies).toHaveLength(0)

    await setApprove(page, control, true)

    // Behavior 1: exactly one write, to this session, carrying only `permission`.
    await expect.poll(() => mock.requests.sessionUpdateBodies.length, { timeout: 15_000 }).toBe(1)
    const rules = rulesetOf(mock.requests.sessionUpdateBodies, 0, SESSION_ID)

    // Behavior 2: the catch-all is FIRST and `*` appears nowhere else, so every grant
    // below it wins under last-match evaluation.
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "ask" })
    expect(
      rules.flatMap((rule, index) => (rule.permission === "*" ? [index] : [])),
      "the wildcard catch-all must appear exactly once, at index 0",
    ).toEqual([0])

    // Behavior 3: closed action vocabulary, tool-wide patterns, nothing denied.
    expect([...new Set(rules.map((rule) => rule.action))].sort()).toEqual(["allow", "ask"])
    expect(
      rules.filter((rule) => rule.pattern !== "*"),
      "every Auto rule is tool-wide; pattern-scoped grants are a separate, unshipped design",
    ).toEqual([])
    expect(
      rules.filter((rule) => rule.action === "deny"),
      "Auto never denies — a denial would fail a tool call instead of asking the user",
    ).toEqual([])

    // Behavior 3: the effective action per named permission. Asserted by property, not
    // as a frozen literal — a future safe addition to a tier adds a rule this loop
    // simply does not look at.
    for (const permission of EXPECT_ALLOWED) {
      expect(effectiveAction(rules, permission), `${permission} must be allowed by Auto`).toBe("allow")
    }
    for (const permission of EXPECT_GATED) {
      expect(effectiveAction(rules, permission), `${permission} must still ask under Auto`).toBe("ask")
    }
    expect(effectiveAction(rules, "*"), "anything unnamed must still ask").toBe("ask")

    // No config PATCH: this delivery is deliberately NOT `PATCH /session/:id/config`
    // (that handler disposes the engine instance and hard-interrupts the running turn).
    expect(mock.requests.configPatchCount).toBe(0)
    await captureSwitchEvidence(page, "enabling-writes-the-auto-ruleset")
  })

  test("disabling Approve for me withdraws every grant the enable wrote — behavior 4", async ({ page }) => {
    await seedOneProject(page, DIR)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "opencode" })

    await openExistingSession(page, DIR, SESSION_ID)
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]').last()).toBeVisible({ timeout: 20_000 })

    const control = await approveSwitch(page)
    await setApprove(page, control, true)
    await expect.poll(() => mock.requests.sessionUpdateBodies.length, { timeout: 15_000 }).toBe(1)

    // What the grant actually contained, read off the wire — so the withdrawal is
    // checked against the tiers as they really are, not against a copy of them here.
    const granted = rulesetOf(mock.requests.sessionUpdateBodies, 0, SESSION_ID)
    const allowedKeys = [...new Set(granted.filter((rule) => rule.action === "allow").map((rule) => rule.permission))]
    expect(
      allowedKeys.length,
      "the enable write granted almost nothing — the withdrawal assertions below would be vacuous",
    ).toBeGreaterThanOrEqual(5)

    await setApprove(page, control, false)

    await expect.poll(() => mock.requests.sessionUpdateBodies.length, { timeout: 15_000 }).toBe(2)
    const withdrawal = rulesetOf(mock.requests.sessionUpdateBodies, 1, SESSION_ID)

    // The core security property: no endpoint deletes rules and the handler merges, so
    // every key that was granted MUST come back as a later `ask` or it stays live in the
    // engine while the UI reads "off".
    for (const permission of allowedKeys) {
      expect(
        withdrawal.some((rule) => rule.permission === permission && rule.pattern === "*" && rule.action === "ask"),
        `${permission} was allowed by the enable write but is not explicitly re-asked by the withdrawal`,
      ).toBe(true)
      expect(effectiveAction(withdrawal, permission), `${permission} does not effectively ask after withdrawal`).toBe(
        "ask",
      )
    }

    // Nothing is granted by a withdrawal, and the catch-all still leads.
    expect(withdrawal[0]).toEqual({ permission: "*", pattern: "*", action: "ask" })
    expect(
      withdrawal.filter((rule) => rule.action !== "ask"),
      "a withdrawal may only contain `ask` rules",
    ).toEqual([])
    // The danger tier is still named explicitly, so a stale `allow` left by some other
    // mode cannot outrank it either.
    for (const permission of EXPECT_GATED) {
      expect(effectiveAction(withdrawal, permission), `${permission} must ask after withdrawal`).toBe("ask")
    }

    expect(mock.requests.configPatchCount).toBe(0)
    await captureSwitchEvidence(page, "disabling-withdraws-every-grant")
  })

  const nonOpencode: { harness: Harness; note: string }[] = [
    { harness: "claude-acp", note: "ACP — Claxedo answers locally, mode ids are open strings" },
    { harness: "claude-sdk", note: "native SDK permission mode — not sent from this control" },
  ]

  for (const harnessCase of nonOpencode) {
    test(`toggling Approve for me on ${harnessCase.harness} writes no ruleset — behavior 5`, async ({ page }) => {
      // ${harnessCase.note}
      const sessionId = `ses_core_permission_${harnessCase.harness.replace(/-/g, "_")}`
      await seedOneProject(page, DIR)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: harnessCase.harness })

      // A DRAFT would write nothing on any harness (behavior 6), so the harness claim
      // has to be made against a REAL session: send once to create it, then toggle.
      const input = await openDraftPrompt(page, DIR)
      // Cross-cutting #1: the seeded harness auto-adopts on mount, so the control
      // already reads the harness's own label rather than "OpenCode".
      await expect(page.locator(`[data-action="prompt-harness-model"][data-harness="${harnessCase.harness}"]`).last()).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]')).toHaveCount(0)

      const first = `permission ruleset ${harnessCase.harness} first turn`
      await composePrompt(page, input, first)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 20_000 }).toBe(1)
      await expectAssistantReplyVisible(page, `ack 1: ${first}`)
      // The harness survived the create/navigate handoff — the session really is this
      // harness's, so "no write" below is a statement about this harness.
      await expect(page.locator(`[data-action="prompt-harness-model"][data-harness="${harnessCase.harness}"]`).last()).toBeVisible({ timeout: 20_000 })
      expect(mock.requests.sessionUpdateBodies).toHaveLength(0)

      // Claxedo offers NOTHING here: this harness reports its own modes, so the
      // picker is that list and nothing else.
      //
      // This assertion has now been wrong in both directions, which is why it spells
      // out the contract rather than a count. It first flipped Claxedo's Auto/Manual
      // on these harnesses and asserted silence; that died when the picker switched
      // to harness-native modes. It was then relaxed to allow one Claxedo "Auto"
      // sitting above the list as a collapsed label, and that row has since been
      // removed — it duplicated whichever rung it pointed at. What has been constant
      // is the thing worth pinning: nothing Claxedo shows may be a rival control that
      // could write a ruleset behind the harness's back.
      const control = await approveSwitch(page)
      await control.click()
      await expect(page.locator('[role="menuitem"][data-mode]').first()).toBeVisible({ timeout: 20_000 })
      const offered = await page
        .locator('[role="menuitem"][data-mode]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-mode") ?? ""))
      expect(
        offered.filter((id) => id.startsWith("claxedo-")),
        `${harnessCase.harness} reports its own modes, so the picker is that list alone — `
          + "two controls over one behaviour with no way to tell which wins",
      ).toEqual([])
      expect(offered.length, "the harness must contribute at least one mode of its own").toBeGreaterThan(0)
      // Dismiss by toggling the TRIGGER, not with Escape, and wait for the menu to
      // actually go.
      //
      // This matters because an open Kobalte menu marks the rest of the page
      // aria-hidden: while it is up, every composer control loses its accessible
      // name at once, including the prompt box the positive control below types
      // into. A still-open menu therefore fails later on a `getByRole` for the
      // textbox, which reads as the composer being broken rather than as the menu
      // never having closed — which is exactly how this spec failed.
      //
      // Toggling the trigger rather than pressing Escape is about being
      // unambiguous, NOT about Escape being broken — it is not.
      //
      // A session page renders two composers and therefore two of these triggers,
      // so `[role="menuitem"]` is a document-wide count that can include a menu
      // this spec never opened. Asserting on that count after a keypress reads a
      // global signal to answer a local question. Toggling the same `control`
      // locator that opened the menu closes exactly what was opened.
      //
      // Recorded because I got this wrong: I read the count as proof Escape had
      // failed, while the trigger in the same snapshot reported aria-expanded
      // false. The trigger was right and I discarded it.
      await control.click()
      await expect(page.locator('[role="menuitem"][data-mode]')).toHaveCount(0, { timeout: 10_000 })

      // POSITIVE CONTROL (authoring rule #3): a request that DID reach the mock after
      // both toggles, proving the app was live and the recorder was watching — rather
      // than sleeping and calling the silence proof.
      const second = `permission ruleset ${harnessCase.harness} second turn`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), second)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 20_000 }).toBe(2)
      await expectAssistantReplyVisible(page, `ack 2: ${second}`)

      expect(
        mock.requests.sessionUpdateBodies,
        `${harnessCase.harness} has no session ruleset mechanism, so nothing in this flow may write one. `
          + `A write here means the composer resolved the harness as "opencode": `
          + `createComposerAutoAccept reads it from currentHarnessType (src/features/session/composer/`
          + `harness-mode-helpers.ts:31), which for a session-mode composer returns sessionHarness(ref).id — and that `
          + `defaults to "opencode" whenever the composer's SessionRef carries no harness, which is the case for a `
          + `local session even though the toolbar's own harness control (asserted above) reads "${
            harnessCase.harness
          }" from a different source. See this spec's returned findings.`,
      ).toEqual([])
    })
  }

  test("toggling Approve for me on a draft writes no ruleset and is not smuggled into session creation — behavior 6", async ({
    page,
  }) => {
    const sessionId = "ses_core_permission_draft"
    await seedOneProject(page, DIR)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "opencode" })

    const input = await openDraftPrompt(page, DIR)
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]').last()).toBeVisible({ timeout: 20_000 })

    // opencode IS the ruleset harness here — the only reason nothing is written is that
    // a draft has no session id to scope a ruleset to.
    const control = await approveSwitch(page)
    await setApprove(page, control, true)
    expect(mock.requests.sessionUpdateBodies).toEqual([])

    // POSITIVE CONTROL: send, which really does create the session — so the emptiness
    // below is measured against a live wire, and additionally proves the pending
    // directory-level preference is not folded into the creation body.
    const text = "permission ruleset draft turn"
    await composePrompt(page, input, text)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.createSessionCount, { timeout: 20_000 }).toBe(1)
    await expect.poll(() => mock.requests.promptCount, { timeout: 20_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${text}`)

    expect(
      mock.requests.createSessionBodies[0]?.body.permission,
      "POST /session must not carry a permission ruleset — the switch delivers by PATCH or not at all",
    ).toBeUndefined()
    expect(
      mock.requests.sessionUpdateBodies,
      "a draft toggle has no session to write to, so it must issue no PATCH /session/:id",
    ).toEqual([])
  })
})
