# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playwright/real-harness-local.spec.ts >> real harness journeys @core @tier-real >> Pi reports unsupported subagents and rejects an unadvertised delegation tool
- Location: e2e/playwright/real-harness-local.spec.ts:1672:3

# Error details

```
Error: assistant reply "PI-UNSUPPORTED-1789365795528" never appeared in a visible assistant-content slot

expect(locator).toBeVisible() failed

Locator: locator('[data-slot="session-turn-assistant-content"]:not([aria-hidden="true"])').filter({ hasText: 'PI-UNSUPPORTED-1789365795528' }).last()
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - assistant reply "PI-UNSUPPORTED-1789365795528" never appeared in a visible assistant-content slot with timeout 20000ms
  - waiting for locator('[data-slot="session-turn-assistant-content"]:not([aria-hidden="true"])').filter({ hasText: 'PI-UNSUPPORTED-1789365795528' }).last()

```

```yaml
- button "Skip to composer"
- navigation:
  - navigation "Projects and sessions":
    - button "Hide Sidebar" [pressed]
    - button "New Project"
    - button "Open Marketplace": Marketplace
    - text: Projects
    - button "Collapse project" [expanded]
    - text: claxedo-tier-real-pi-subagent-y6Xnma
    - 'button "Reply with exactly this one token: PI-UNSUPPORTED-1789365795528"'
    - text: "Reply with exactly this one token: PI-UNSUPPORTED-1789365795528 18s"
    - button "Local workspace"
- main:
  - button "New Session"
  - button "New Terminal"
  - button "Open workspace panel"
  - button "Scroll to latest message"
  - region "scrollable content":
    - 'heading "Reply with exactly this one token: PI-UNSUPPORTED-1789365795528" [level=1]'
    - button "More options"
    - text: "Reply with exactly this one token: PI-UNSUPPORTED-1789365795528 Build · openai/gpt-4 · 11:33 AM"
    - button "Copy message"
    - status:
      - text: Reconnect your AI provider The provider rejected the credential for this workspace.
      - 'button "Incorrect API key provided: test-key. You can find your API key at https://platform.openai.com/account/api-keys."'
      - button "Reconnect and resend"
  - textbox "Ask anything, / for commands, @ for context..."
  - text: Ask anything, / for commands, @ for context...
  - button "Add"
  - button "Select harness and model": GPT-4
  - button "Type a message to get started" [disabled]
  - complementary "Session environment":
    - button "Open changes"
    - button "Open files"
    - button "Open processes"
    - button "Expand Environment"
- region "Notifications (alt+T)":
  - list
```

# Test source

```ts
  1   | // The oracle. Every spec that sends a prompt proves the reply through this module —
  2   | // never through a bare `getByText`/`locator` on assistant text. See
  3   | // `e2e/INVARIANTS.md` ("The Oracle") for the doctrine this implements.
  4   | //
  5   | // Three layers, ALL required, in order:
  6   | //   (a) DOM truth      — text present in a *visible* assistant-content slot, Thinking
  7   | //                         row gone, submit control back to ready.
  8   | //   (b) Geometric truth — non-zero bounding box inside the viewport, and a hit-test
  9   | //                         (elementFromPoint) that actually resolves inside the slot.
  10  | //   (c) Visual evidence — a screenshot captured at the moment of the claim, written to
  11  | //                         test-results/evidence/<spec>/<scenario>.png for later human/AI
  12  | //                         review. The screenshot is evidence, not proof — see doctrine.
  13  | import { expect, test, type Locator, type Page } from "@playwright/test"
  14  | import { mkdirSync } from "node:fs"
  15  | import { join } from "node:path"
  16  | 
  17  | export const SELECTORS = {
  18  |   assistantContent: '[data-slot="session-turn-assistant-content"]',
  19  |   assistantContentVisible: '[data-slot="session-turn-assistant-content"]:not([aria-hidden="true"])',
  20  |   userMessageContent: '[data-slot="session-turn-message-content"]',
  21  |   thinkingRow: '[data-slot="session-turn-thinking"]',
  22  |   submitControl: '[data-action="prompt-submit"]',
  23  |   toolPart: (partId: string) => `[data-timeline-part-id="${partId}"]`,
  24  | } as const
  25  | 
  26  | export type Evidence = {
  27  |   /** Spec basename, e.g. "core-first-prompt-local" (no directory, no .spec.ts). */
  28  |   spec: string
  29  |   /** Scenario slug, e.g. "first-send-renders-reply". Filesystem-safe. */
  30  |   scenario: string
  31  |   /** Real harness subprocesses can need longer than the mocked-lane default. */
  32  |   timeout?: number
  33  | }
  34  | 
  35  | function slugify(value: string) {
  36  |   return value
  37  |     .toLowerCase()
  38  |     .trim()
  39  |     .replace(/[^a-z0-9]+/g, "-")
  40  |     .replace(/^-+|-+$/g, "")
  41  |     .slice(0, 120) || "scenario"
  42  | }
  43  | 
  44  | /** Derives {spec, scenario} from Playwright's `testInfo` when the caller omits it. */
  45  | function resolveEvidence(explicit?: Evidence): Evidence {
  46  |   if (explicit) return explicit
  47  |   const info = test.info()
  48  |   const specFile = info.file.split(/[\\/]/).pop() ?? "spec"
  49  |   const spec = specFile.replace(/\.spec\.ts$/, "")
  50  |   const scenario = slugify(info.titlePath.slice(1).join(" ") || info.title)
  51  |   return { spec, scenario }
  52  | }
  53  | 
  54  | function evidencePath(evidence: Evidence, repoRoot: string, suffix = "") {
  55  |   const dir = join(repoRoot, "test-results", "evidence", evidence.spec)
  56  |   mkdirSync(dir, { recursive: true })
  57  |   return join(dir, `${evidence.scenario}${suffix}.png`)
  58  | }
  59  | 
  60  | /**
  61  |  * appRoot: the claxedo-app package root, used to resolve the evidence directory
  62  |  * independent of process.cwd(). Every helper below defaults to
  63  |  * `process.cwd()` when omitted, which is correct when Playwright is invoked from
  64  |  * `packages/claxedo-app` (the documented/only supported invocation directory).
  65  |  */
  66  | function packageRoot() {
  67  |   return process.cwd()
  68  | }
  69  | 
  70  | /**
  71  |  * Layer (a): DOM truth. Locates the assistant-content slot that is NOT aria-hidden
  72  |  * and contains `text`. Returns the Locator for layers (b)/(c) to reuse — never
  73  |  * re-queries by text a second time (that would open a re-render race).
  74  |  */
  75  | async function domTruth(page: Page, text: string | RegExp, timeout = 20_000): Promise<Locator> {
  76  |   const visible = page.locator(SELECTORS.assistantContentVisible).filter({ hasText: text })
> 77  |   await expect(visible.last(), `assistant reply "${text}" never appeared in a visible assistant-content slot`).toBeVisible({
      |                                                                                                                ^ Error: assistant reply "PI-UNSUPPORTED-1789365795528" never appeared in a visible assistant-content slot
  78  |     timeout,
  79  |   })
  80  |   return visible.last()
  81  | }
  82  | 
  83  | async function thinkingRowGone(page: Page) {
  84  |   await expect(
  85  |     page.locator(SELECTORS.thinkingRow),
  86  |     "a Thinking row is still present after the turn claims to be settled",
  87  |   ).toHaveCount(0, { timeout: 20_000 })
  88  | }
  89  | 
  90  | async function submitControlReady(page: Page) {
  91  |   const submit = page.locator(SELECTORS.submitControl).last()
  92  |   await expect(submit, "submit control never returned to ready (still shows the busy/stop icon)").not.toHaveAttribute(
  93  |     "data-icon",
  94  |     "stop",
  95  |     { timeout: 20_000 },
  96  |   )
  97  | }
  98  | 
  99  | /**
  100 |  * Explicit model pick through the real harness/model control.
  101 |  *
  102 |  * Product rule: drafts do not invent a catalog default. Specs that send a first
  103 |  * prompt must drive the same picker a user would (same shape as
  104 |  * `selectScriptedModel`). No-ops when a concrete model is already selected.
  105 |  *
  106 |  * Defaults to GPT-5 when present; otherwise picks the first visible model option
  107 |  * so harness-specific catalogs (codex-acp, etc.) still work.
  108 |  */
  109 | export async function ensureComposerModelSelected(
  110 |   page: Page,
  111 |   options?: { readonly modelName?: RegExp; readonly search?: string },
  112 | ) {
  113 |   const preferredName = options?.modelName ?? /^GPT-5$/i
  114 |   const searchText = options?.search ?? "GPT-5"
  115 |   const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  116 |   await expect(control, "the composer's harness+model control never appeared").toBeVisible({ timeout: 30_000 })
  117 |   await expect(control, "the harness+model control stayed disabled while the catalog loaded").toBeEnabled({
  118 |     timeout: 45_000,
  119 |   })
  120 |   const label = (await control.innerText()).trim()
  121 |   const ready = (await control.getAttribute("data-ready-for-submit")) === "true"
  122 |   const modelAttr = (await control.getAttribute("data-model"))?.trim() ?? ""
  123 |   if (label && !/Loading models|Select model|^$/i.test(label) && ready && modelAttr) return
  124 | 
  125 |   await control.click()
  126 |   const popover = page.locator('[data-component="harness-model-picker"]')
  127 |   await expect(popover, "the harness/model picker popover never opened").toBeVisible({ timeout: 15_000 })
  128 |   const search = page.getByRole("textbox", { name: /Search models/i }).last()
  129 |   await expect(search, "the harness/model picker's search box never appeared").toBeVisible({ timeout: 20_000 })
  130 |   await search.fill(searchText)
  131 |   // Model rows are List items (`data-slot="list-item"`). Never click the first
  132 |   // popover button — Harness/Model section headers are also buttons and leave
  133 |   // the trigger stuck on "Select model".
  134 |   const modelRows = popover.locator('[data-slot="list-item"]')
  135 |   const preferred = modelRows.filter({ hasText: preferredName }).first()
  136 |   if ((await preferred.count()) > 0) {
  137 |     await expect(preferred, `model ${searchText} missing from the picker`).toBeVisible({ timeout: 20_000 })
  138 |     await preferred.click()
  139 |   } else {
  140 |     await search.fill("")
  141 |     const option = modelRows.first()
  142 |     await expect(option, "no selectable model appeared in the picker").toBeVisible({ timeout: 20_000 })
  143 |     await option.click()
  144 |   }
  145 |   if (await popover.isVisible().catch(() => false)) {
  146 |     await page.keyboard.press("Escape")
  147 |   }
  148 |   await expect(popover, "the harness/model picker stayed open after model selection").toBeHidden({
  149 |     timeout: 10_000,
  150 |   })
  151 |   await expect(control, "harness+model control never adopted a selected model").not.toContainText(
  152 |     /Loading models|Select model|^$/i,
  153 |     { timeout: 20_000 },
  154 |   )
  155 | }
  156 | 
  157 | /** Selects an agent target through the same unified picker used by a real draft. */
  158 | export async function selectComposerAgent(page: Page, agentName: string | RegExp) {
  159 |   const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  160 |   await expect(control, "the composer's harness+model control never appeared").toBeVisible({ timeout: 30_000 })
  161 |   await expect(control, "the harness+model control stayed disabled").toBeEnabled({ timeout: 45_000 })
  162 |   await control.click()
  163 | 
  164 |   const picker = page.locator('[data-component="harness-model-picker"]')
  165 |   await expect(picker, "the harness/model picker popover never opened").toBeVisible({ timeout: 15_000 })
  166 |   const harnessSection = picker.locator('[data-slot="harness-picker-section"]').first()
  167 |   await expect(harnessSection, "the agent section never appeared in the picker").toBeVisible({ timeout: 20_000 })
  168 |   await harnessSection.click()
  169 | 
  170 |   const option = picker.getByRole("button", { name: agentName, exact: typeof agentName === "string" })
  171 |   await expect(option, `agent ${String(agentName)} missing from the picker`).toBeVisible({ timeout: 20_000 })
  172 |   await option.click()
  173 |   if (await picker.isVisible().catch(() => false)) await page.keyboard.press("Escape")
  174 |   await expect(picker, "the harness/model picker stayed open after agent selection").toBeHidden({ timeout: 10_000 })
  175 | }
  176 | 
  177 | /**
```