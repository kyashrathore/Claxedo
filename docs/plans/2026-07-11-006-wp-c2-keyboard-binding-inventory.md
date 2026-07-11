# WP-C2 — Keyboard-Shortcut Binding-Surface Inventory (Pre-Scoping)

Date: 2026-07-11
Status: read-only inventory — **no source edited**. Produced to unblock WP-C2 execution.
Wave: 3 (Product-goal features)
Parent WP: WP-C2 · Keyboard-shortcut consolidation, LLD `2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md`
  lines 456–464. Waiver ledger: `2026-07-11-002-fixme-ledger-wp-reconciliation.md` (W9 row,
  `core-panes-split-tabs:580`/`:591`). Audit basis:
  `2026-07-10-003-claxedo-app-audit-findings-appendix.md` lines 114–137, 996.
Scope: `packages/claxedo-app` only (one cross-package finding on `packages/claxedo-desktop`
  is called out explicitly in §1.17/§5 because it changes the reachability analysis for W9).
Paths are relative to `packages/claxedo-app` unless prefixed `packages/`.

> **Live-tree note.** The LLD's "Owns" list for WP-C2 (`src/context/command.tsx`,
> `src/claxedo-ui/layout/keyboard.ts`, `src/claxedo-ui/layouts/rail-keyboard-commands.ts`,
> `src/claxedo-ui/claxedo-layout-commands.ts`) predates the WP-ORG-2 rename. In the live tree:
> `src/context/command.tsx` is unchanged (still the real path); `claxedo-ui/layout/keyboard.ts`
> → `src/claxedo-ui/workbench/keyboard.ts`; `claxedo-ui/layouts/rail-keyboard-commands.ts` →
> `src/claxedo-ui/rail/rail-keyboard-commands.ts`; `claxedo-layout-commands.ts` does not exist
> under that name — the nearest equivalents are `src/claxedo-ui/rail/layout-commands.ts`
> (process-pane toggle command) and `src/shell/layout/commands.ts` (pure `LayoutCommand`
> reducer helpers, not a keyboard system — see §1 "not a binding site").

> **Post-B2 state confirmed.** `rail-keyboard-commands.ts:16-26,62-69` now omits `keybind` on
> `claxedo.pane.close` and `claxedo.split.focusLeft`/`focusRight`, with inline comments naming
> the workbench listener as sole owner, and `rail-keyboard-commands.test.ts:31-49` pins a
> regression test that the workbench `resolveKeyMap()` chords are never also bound by
> `rail-keyboard-commands.ts`. **This inventory found that the underlying two-systems problem
> is not fully closed** — three *other* live registration sites re-introduce chord collisions
> the B2 test cannot see (it only compares one command source against the workbench listener).
> See §0 and §2.

---

## 0. TL;DR — what's new beyond B2

1. **`mod+w` is still bound by three independent live systems, not the two the audit
   described.** B2 removed the registry/workbench collision for `claxedo.pane.close`. But
   `pages/session/use-session-commands.tsx:198-209` registers a *separate* command,
   `tab.close` (closes the active file tab in the file-viewer pane), also on `mod+w`, through
   the same canonical command registry (`context/command.tsx` → `command-palette.tsx`). Its
   `document`-level bubble-phase listener (`command-palette.tsx:396`) never calls
   `stopPropagation` (`command-palette.tsx:372-393`), so on any keypress it doesn't consume,
   the event still reaches `workbench.tsx`'s `window`-level bubble-phase listener
   (`workbench.tsx:153-161`), which independently matches `mod+w` and calls
   `wb.split.close(...)`. When a file tab is open, **pressing `mod+w` today closes the file
   tab and closes the pane in the same keystroke** — same class of bug the B2 test was written
   to catch, just from an un-checked fourth call site. No existing test enumerates
   `use-session-commands.tsx`'s registrations against the workbench keymap.
2. **`mod+w` has a fourth handler in the V2 titlebar**, a `document`-level **capture-phase**
   listener (`titlebar.tsx:326-338`, only mounted when `USE_V2_TITLEBAR` — i.e.
   `VITE_OPENCODE_CHANNEL !== "prod"`, `titlebar.tsx:62`, which is the default/beta channel).
   It runs *before* both of the above (capture beats bubble), and if it closes a session tab
   it calls both `preventDefault()` and `stopPropagation()` — which, because propagation is
   already stopped at capture time, **prevents the `tab.close` command and the workbench
   `closePane` handler from ever seeing the event** whenever there's a session tab to close.
   Net effect: which of the (at least) three `mod+w` behaviors wins depends on titlebar
   channel gating, whether a session tab exists, and whether a file tab is open — undocumented,
   untested, and not something a keyboard user can predict.
3. **The command registry itself has same-registry, same-signature collisions** the B2 test
   structurally cannot catch (it only ever compares two specific sources):
   - `mod+shift+s` is registered twice: `session.new` (`use-session-commands.tsx:171`) and
     `theme.scheme.cycle` (`shell/app-shell-commands.ts:71`). `command-palette.tsx`'s `keymap`
     memo (`command-palette.tsx:336-352`) does `if (map.has(sig)) continue` — first-registered
     wins, the other is silently unreachable by keyboard (still palette-invokable).
   - `mod+1..9` is registered twice: `claxedo.surface.1..9` (`rail-keyboard-commands.ts:55-61`,
     switches workbench surface) and `tab.1..tab.9` (`titlebar.tsx:376-391`, jumps to the Nth
     session tab, `hidden: true` so it's invisible in the palette too). Same
     first-registered-wins/other-silently-dead outcome, again gated by `USE_V2_TITLEBAR`.
   - `mod+option+ArrowLeft`/`mod+option+ArrowRight` (`titlebar.tsx:346,363`, tab-cycling,
     `hidden: true`) parse to the **same signature** as `mod+alt+ArrowLeft`/`ArrowRight`
     (`command-palette.tsx:138-140` treats `"alt"` and `"option"` as the same modifier flag) —
     which is the exact chord family the audit already flagged colliding with the workbench's
     geometric `focusLeft`/`focusRight`. B2 only removed the *registry-side* half of that
     collision from `rail-keyboard-commands.ts`; `titlebar.tsx` re-adds a registry-side
     `mod+alt+Arrow` binding through a different file, so the workbench-vs-registry collision
     for this chord family is still live, just moved.
4. **`terminal.toggle` has no registered command anywhere** (verified: no
   `id: "terminal.toggle"` registration in the tree) despite being referenced by
   `command-palette.tsx:16`'s `EDITABLE_KEYBIND_IDS`, `session-header.tsx:484`'s keybind-label
   lookup, and `desktop-menu.ts:145`'s Windows/Linux menu entry. The Toggle Terminal button
   (`session-header.tsx:230-238`) only works via direct `onClick`; there is currently no
   keyboard path to it through the command registry at all, and its displayed shortcut badge
   resolves to an empty string.
5. **The native macOS Electron menu (`packages/claxedo-desktop/src/main/menu.ts`, outside this
   package's scope but load-bearing for the W9 answer) sends several `command:` ids that don't
   exist in the renderer's command registry**: `"claxedo.tab.close"` (should be `"tab.close"`,
   accelerator `Cmd+W`), `"sidebar.toggle"` (should be `"claxedo.sidebar.toggle"`, accelerator
   `Cmd+B`), `"claxedo.split.toggle"` (no such command exists anywhere; accelerator `Cmd+\`),
   `"session.previous"`/`"session.next"` (no such commands; `Option+Up`/`Option+Down`),
   `"project.open"` (no such command; `Cmd+O`). Electron's native accelerator system claims
   these key combinations for the whole focused window before any renderer-level `keydown`
   listener ever runs, so on real macOS desktop builds **these five accelerators are silent
   no-ops today** — including `Cmd+W`, which is the chord this whole inventory is about. This
   is evidence-from-static-analysis (grep + code reading), not a live-launched-Electron
   observation; flagged as high-confidence but unverified-at-runtime per repo convention. See
   §5 for what this means for W9.

---

## 1. Binding-surface inventory, by system

### 1.1 Canonical command registry — `context/command.tsx` + `context/command-palette.tsx`

This is the system the LLD names as the target dispatch path ("UI, voice, remote, server-pushed
use the same typed command path"). `context/command.tsx:23-37` wraps the upstream
`CommandProvider`/`useCommand` (from `command-palette.tsx`) in a `CommandBusProvider` and three
bridges:
- `LegacyCommandBusBridge` (`command.tsx:56-66`) — re-routes `bus.dispatch(legacyCommandTrigger)`
  back into `command.trigger(id, source)`.
- `ServerCommandBusBridge` (`command.tsx:68-94`) — listens for `globalSDK.event.on(...)` on
  `legacyCommandTriggerType`, `"tui.command.execute"`, `"remote-agent.command.execute"`,
  `"voice-agent.command.execute"` and forwards them onto the bus. This is the actual "voice,
  remote, server-pushed" fan-in the LLD refers to.
- `TrustedAgentContributionBridge` (`command.tsx:96-108`) — unrelated to keybinds (content-surface
  contributions), not a keyboard concern.

The real chord-matching engine lives in `command-palette.tsx`:
- `parseKeybind` (`command-palette.tsx:110-153`) parses a config string (`"mod+shift+p"`) into
  `{key, ctrl, meta, shift, alt}`; `"mod"` → `meta` on Mac else `ctrl` (`:134-136`); `"alt"`/
  `"option"` both set `alt` (`:138-140`).
  `matchKeybind`/`signature` (`:51-58,155-171`) build a normalized string key for exact
  4-modifier + key comparison.
- `commandContextInput.init` (`command-palette.tsx:243-449`) holds `store.registrations`
  (per-caller `register()` entries, `:399-414`), a `registered` memo that **de-dupes by id,
  first-registered wins** and warns on duplicate ids in dev (`:268-287` — note: this only
  catches duplicate *ids*, not duplicate *keybinds* on different ids, which is the actual
  collision shape found in §0.3), and a `keymap` memo (`:336-352`) that builds
  `Map<signature, CommandOption>`, again first-registered-wins on collision, **silently** (no
  warning for keybind collisions, unlike id collisions).
- `handleKeyDown` (`:372-393`), wired via `makeEventListener(document, "keydown", handleKeyDown)`
  at `:396` (bubble phase, `document` target, **no capture flag**): bails if `suspended()` or
  `dialog.active` (`:373`); bails for editable targets unless the matched option's id is in
  `EDITABLE_KEYBIND_IDS` (`terminal.toggle`, `terminal.new`, `file.attach` — `:16,60-63,381`) or
  a modifier/`Tab` is held; on palette-hotkey match calls `preventDefault()` + opens the palette
  (`:384-388`, no `stopPropagation`); on command match calls `preventDefault()` +
  `option.onSelect?.("keybind")` (`:390-392`, **no `stopPropagation` in either branch**). This
  is the root cause of §0.1/§0.3 — nothing here stops the event from continuing to bubble past
  `document` to `window`, where `workbench.tsx`'s listener also lives.
- `register()` (`:399-414`) is the public API every command-source file below calls
  (`useCommand().register(...)` or `useCommand().register(key, ...)`).
- Discoverability: `catalog`/`catalogOptions` (`:255-308`) persist `{title, description,
  category, keybind, slash}` per command id to `Persist.global("command.catalog.v1")` so the
  palette can list commands even before their owning component has mounted for the current
  session — this is the existing discoverability surface the LLD's "command palette lists
  bindings" step can build on directly; it's not tied to a specific dispatch path so no
  migration work is needed here.

Focus-scope: whole-document, gated on `isEditableTarget` (`:235-241`, checks
`isContentEditable` / closest `contenteditable='true'` / closest `input, textarea, select`),
`dialog.active`, and `suspended()` (used by `settings/keybinds.tsx` during rebind capture, and
by anything calling `command.keybinds(false)`).

**Command sources registered into this system** (each a `command.register(...)` call site —
these are not separate *dispatch* systems, just separate *registration* call sites feeding the
one dispatcher, but each is a place a new/changed keybind can silently collide):
- `pages/session/use-session-commands.tsx` — `session.new` (`:171`, `mod+shift+s`), `file.open`
  (`:185`, `mod+p`), `tab.close` (`:201`, `mod+w`, `disabled: !tabs().active()`),
  `context.addSelection` (`:217`, `mod+shift+l`), `review.toggle` (`:248`, `mod+shift+r`),
  `fileTree.toggle` (`:280`, `mod+shift+e` — comment at `:276-277` notes this was deliberately
  changed off upstream's `mod+\` because Claxedo repurposes `mod+\` for split), `input.focus`
  (`:289`, `ctrl+l`), `terminal.new` (`:296`, `ctrl+alt+t`), `steps.toggle` (`:321`, `mod+e`),
  `message.previous`/`message.next` (`:337,345`, `mod+arrowup`/`mod+arrowdown`), `model.choose`
  (`:356`, `mod+'`), `mcp.toggle` (`:367`, `mod+;`), `agent.cycle`/`agent.cycle.reverse`
  (`:378,389`, `mod+.`/`shift+mod+.`), `model.variant.cycle` (`:399`, `shift+mod+d`),
  `permissions.autoaccept` (`:411`, `mod+shift+a`).
- `shell/app-shell-commands.ts:43-84` — `theme.cycle` (no keybind), per-theme `theme.set.*` (no
  keybind), `theme.scheme.cycle` (`:71`, `mod+shift+s`), per-scheme `theme.scheme.*` (no
  keybind), plus `createProcessPaneToggleCommand()` from `claxedo-ui/rail/layout-commands.ts:3-11`
  (`processPane.toggle`, `mod+shift+;`).
- `claxedo-ui/rail/rail-keyboard-commands.ts:13-77` (wired via
  `rail-keyboard-controller.tsx:47-82`) — see §1.3.
- `components/titlebar/titlebar.tsx` — `common.goBack`/`common.goForward` (`:144-156`, `mod+[`/
  `mod+]`), plus V2-only `tab.prev`/`tab.next`/`tab.1..tab.9` (`:342-394`, see §0.3).
- `components/prompt-input/mode-commands.ts:9-52` — `prompt.mode.normal`/`prompt.mode.shell`ish
  entries: a `mod+u` file-attach-picker entry (`:35`) and mode-toggle keys sourced from
  `promptShellModeKey`/`promptNormalModeKey` constants (`:43,51`; these are the same `!`-based
  chord the composer's local `editor-keymap.ts:66` also special-cases — see §1.5's note on
  overlap).
- `components/dialogs/select-file.tsx:48,68` — per-row `keybind: option.keybind` passthrough for
  a static list including `"terminal.new"` as a display item, not a new binding.
- `components/prompt-input/popover-controller.ts:76` — passes through `keybind: opt.keybind` for
  @-mention/slash items; not a new binding.

**Not a binding site (checked, ruled out):** `context/settings.tsx:266` (`set(action, keybind)`
— this is the *storage* setter for `settings/keybinds.tsx`'s rebind UI, see §1.16, not a chord
matcher itself).

### 1.2 Workbench window-keydown listener — `claxedo-ui/workbench/workbench.tsx` + `keyboard.ts`

`claxedo-ui/workbench/keyboard.ts` (44 lines, read in full):
- `matchKey(event, spec)` (`:7-27`) — hand-rolled chord matcher, independent implementation of
  the same "mod/alt/option/shift" parsing `command-palette.tsx` does, **not shared code**.
  `needMod` accepts either `metaKey` or `ctrlKey` regardless of platform (`:25`) — looser than
  `command-palette.tsx`'s platform-aware `parseKeybind`, a second, subtly different definition
  of "mod" in the tree.
- `resolveKeyMap(partial)` (`:29-39`) — defaults: `closePane: "mod+w"`, `focusLeft/Right/Up/Down:
  "mod+alt+ArrowLeft/Right/Up/Down"`, `splitRight: "mod+\\"`, `splitDown: "mod+shift+\\"`.
- `eventTargetIsEditable(target)` (`:42-48`) — separate, third implementation of the
  editable-target check (vs. `command-palette.tsx:235-241` and `session.tsx:849`).

`workbench.tsx:151-200`:
- `onKeyDown` (`:153-194`), wired via `window.addEventListener("keydown", onKeyDown)` at
  `:195-199` (bubble phase, `window` target, mounted once per `<Workbench>` instance): bails on
  `eventTargetIsEditable` (`:154`). `closePane` (`mod+w`) → `preventDefault()` +
  `wb.split.close(focusedPaneId, {destroyContent: false})` (`:157-161`). `splitRight`/
  `splitDown` (`mod+\`/`mod+shift+\`) → `preventDefault()`, finds the most-recently-used hidden
  surface (`wb.selectors.mruHiddenContent()`) and splits it into view beside the focused pane
  (`:162-176` — comment documents this replaced a prior self-drop-guard-rejected no-op, the bug
  pinned by `core-panes-split-tabs:591`). `focusLeft/Right/Up/Down` (`mod+alt+Arrow*`) →
  `preventDefault()` + `moveFocusByDirection(direction, ctx.getState(), wb)` (`:177-193`) — a
  geometric nearest-pane-by-rect algorithm (defined elsewhere in this file, not re-read here).
- A second, unrelated listener in the same component: `onWindowKey` (`:206-210`), wired at
  `:211-222` — `Escape` only, cancels an in-progress drag-and-drop (`setDragSuppressed(true)`).
  No preventDefault/stopPropagation. Not chord-related, listed for completeness since it's the
  same `window.addEventListener("keydown", ...)` pattern.

Lines 1-140 of `workbench.tsx` were also checked: no additional keyboard code before line 151
(pure setup — ResizeObserver, focus-change effect, pane-resize RAF throttling).
`claxedo-ui/workbench/index.ts` (26-line barrel) does **not** re-export `matchKey`/
`resolveKeyMap`/`eventTargetIsEditable` — they're workbench-internal only.

### 1.3 Rail keyboard commands — `claxedo-ui/rail/rail-keyboard-commands.ts` (registers into §1.1)

Already quoted in full in the live-tree note above. Post-B2 state: `claxedo.pane.close` and
`claxedo.split.focusLeft`/`focusRight` (`:16-26,62-75`) have **no** `keybind` field — palette
and voice/remote/server dispatch only, by design, per the inline comments naming the workbench
listener (§1.2) as sole chord owner. Live keybinds still registered here: `claxedo.surface.next`
(`:31`, `mod+tab`), `claxedo.surface.previous` (`:38`, `mod+shift+tab`), `claxedo.surface.reopen`
(`:45`, `mod+shift+t`, **`onSelect: () => {}` — a no-op stub**, flagged for whoever owns WP-C2 as
a pre-existing dead command unrelated to this inventory), `claxedo.sidebar.toggle` (`:52`,
`mod+b`), `claxedo.surface.1..9` (`:55-61`, `mod+1..9` — collides with `titlebar.tsx`'s
`tab.1..9`, see §0.3/§2). Wired into the registry via
`rail-keyboard-controller.tsx:47-82`'s `input.command.register(() => createRailKeyboardCommands({...}))`.
`rail-keyboard-controller.tsx:22-45`'s `closeFocusedPane` is also where the desktop "Quit
Claxedo?" dialog lives (`platform.platform === "desktop"` branch, `:27-40`) — see §5.

### 1.4 Terminal — `terminal/backend/keyboard.ts` (xterm `attachCustomKeyEventHandler`, not DOM)

Read in full (109 lines). This is **not** a `document`/`window` `addEventListener` — it's
`xterm.attachCustomKeyEventHandler(handler)` (`:107`), an xterm-specific hook that runs before
xterm's own default key handling and returns `true` (let xterm/PTY handle it) or `false`
(handler already acted, suppress xterm's default). Two families:
- **PTY-forwarding chords** (return `false`, write raw escape/control bytes via
  `options.onWrite`, no DOM `preventDefault`/`stopPropagation` — those concepts don't apply at
  this layer): `Shift+Enter` → `onShiftEnter()` callback only, no bytes (`:27-32`);
  `Cmd/Ctrl+Backspace` → `\x15\x1b[D` (`:35-40`); Mac-only `Option+ArrowLeft/Right` → `\x1bb`/
  `\x1bf` (`:43-52`); `Cmd/Ctrl+ArrowLeft/Right` → `\x01`/`\x05` (`:55-68`); `Ctrl+C` → `\x03`,
  explicitly to preempt the browser's native copy shortcut from stealing it (`:72-77`).
- **App-level chords** (return `false` **and** call real DOM `preventDefault()`/
  `stopPropagation()`): `Cmd+D` → `onSplitVertical()` (`:80-87`); `Cmd+Shift+D` →
  `onSplitHorizontal()` (`:90-97`). These are a **fourth, terminal-scoped split mechanism**,
  semantically the same action as the workbench's `mod+\`/`mod+shift+\` (§1.2) but on
  completely different chords, only reachable when a terminal surface has xterm focus — not a
  literal chord collision, but a semantic duplication worth resolving in the same pass (one
  "split" command, two chord families depending on focus target, is exactly the kind of
  fragmentation WP-C2 exists to remove).
- **Deliberate pass-through**: `Ctrl+`` `` (backtick) → returns `true` unconditionally
  (`:100-102`), explicitly commented "Allow Ctrl+` for parent app toggle" — i.e. this file
  *intentionally* declines to consume that chord so it can bubble up to whatever
  higher-level listener owns "toggle terminal." Per §0.4, that upstream registration
  (`terminal.toggle`) doesn't actually exist today, so this pass-through currently lands nowhere.

### 1.5 Prompt-input / composer editor keymap — `components/prompt-input/editor-keymap.ts`

Read in full (202 lines). `createPromptInputKeyDown(deps)` (`:53-183`) returns the handler wired
onto the prompt editor's own `onKeyDown` (`components/prompt-input/frame.tsx:209`,
`onKeyDown={props.onEditorKeyDown}`, composed in `session-client/composer/composer.tsx:673`).
Component-local, deeply coupled to editor DOM/caret state (`getCursorPosition`,
`canNavigateHistoryAtCursor`) — this is the single largest ad-hoc chord table in the tree:
`mod+u` → open file-attach picker, gated `mode()==="normal"` (`:55-60`); `!` at cursor 0 in
normal mode → switch to shell mode (`:66-73`); `Escape` → 4-way cascade (close popover / exit
shell mode / abort running turn / blur editor on macOS desktop only, via `deps.escBlur()`,
`composer.tsx:447`) (`:75-102`); `Backspace` at empty-shell-mode start → revert to normal mode
(`:105-112`); `Shift+Enter` → insert newline (`:114-118`); `Enter` while IME composing → no-op
(`:120-122`); `Tab` while popover open → select active item (`:126-131`); `ArrowUp/Down`/`Enter`/
`Ctrl+n`/`Ctrl+p` while popover open → list nav (`:132-145`); `Ctrl+G` → close popover or abort
(`:148-159`); bare `ArrowUp/Down` at collapsed caret → prompt-history navigation (`:161-173`);
plain `Enter` → submit (`:175-181`, guards on `repeat`/`booting()`/`working()&&blank()`). Every
branch that acts calls `preventDefault()`; only the `Escape` branches also call
`stopPropagation()`. This file's `mod+u` overlaps conceptually with `prompt-input/mode-commands.ts:35`'s
registry-side `mod+u` file-attach entry (§1.1) — both exist because `mod+u` is one of the three
`EDITABLE_KEYBIND_IDS`-allowed chords, so it's reachable from inside the editable prompt textbox
via the registry path *and* independently short-circuited here; worth reconciling during
migration rather than treating as two separate features.

### 1.6 Page-editor (Tiptap/ProseMirror rich-text) — `claxedo-ui/components/page-editor/*`

`page-editor.tsx` is a **Tiptap/ProseMirror** editor (`@tiptap/pm/state`, `@tiptap/core`,
`@tiptap/suggestion`, `createTiptapEditor`, `StarterKit`). The large majority of keystrokes
(letters, formatting, backspace/delete, list/indent, native arrow navigation) are handled
internally by ProseMirror's own keymap and never surface as explicit handlers in this
codebase — those must not be migrated (§4). Explicit/custom sites layered on top:
- `editorProps.handleKeyDown` (`page-editor.tsx:292-301`) — `Cmd/Ctrl+A` scoped select-all
  (block, then whole-doc on second press), via `handleScopedSelectAll` in
  `page-editor-utils.ts:661-681`. `preventDefault()` yes, no `stopPropagation`. Focus-scope:
  ProseMirror view only.
- `onWindowKeyDown` (`page-editor.tsx:550-579`), wired `window.addEventListener("keydown",
  onWindowKeyDown, true)` at `:604` — **capture phase**, so it runs before every bubble-phase
  listener in this inventory, regardless of focus. `Escape`-only, priority cascade over Solid
  signal state (not `event.target`): link-menu → table-menu → AI-preview → AI-menu → more-menu
  → fallback `HIDE_ALL` (`:552-578`). `preventDefault()` on every branch, **no**
  `stopPropagation`. Because this is capture-phase, it pre-empts several component-local Escape
  handlers nested inside the same editor tree even though those never fire because this one
  already consumed the visible state: `page-editor-overlay.tsx:74` (AI-composer textarea
  Escape) and `page-editor-toolbar.tsx:227` (link-input Escape) are effectively dead code paths
  for `Escape` specifically (still live for their `Enter` branches) — this file's capture
  listener always wins first when those overlays are open.
- `onTitleKeyDown` (`page-editor.tsx:681-686`, on the title `<input>`, `:893`) — `Enter` only,
  moves focus into the editor body.
- `mermaid-block.ts` — inline diagram viewport pan/zoom via `mermaidKeyAction`
  (`mermaid-keyboard.ts:20-41`, pure mapper: `+`/`=` zoom in, `-`/`_` zoom out, `0` reset,
  `Arrow*` pan), wired `viewport.addEventListener("keydown", onKeyDown)` at `:216`, scoped to
  the focused, `tabIndex=0` viewport element with an `aria-label` describing the keys (`:205-209`
  — this is a rare example of a self-documenting/discoverable ad-hoc binding already). A
  **second, separate** `document.addEventListener("keydown", onKeyDown)` at `:426` handles
  `Escape` for the fullscreen diagram overlay — global, bubble-phase, no preventDefault, so it
  can be starved by any earlier handler (including `page-editor.tsx`'s capture-phase Escape
  listener) that stops propagation first.
- `page-arena-dock.tsx:462-466` — `Enter` (no shift) on the arena composer textarea submits.
- `page-editor-dock.tsx:301-306` — `Enter`/`Space` on a synthetic close-tab `span[role=button]`,
  `preventDefault`+`stopPropagation` (to stop the click from also bubbling to the parent tab
  button).
- `page-editor-overlay.tsx:68-77` — AI-composer textarea `Enter`(submit)/`Escape`(close); the
  Escape branch is the dead-in-practice one noted above.
- `page-editor-toolbar.tsx:221-230` — link-input `Enter`(apply)/`Escape`(close popover); same
  dead-Escape-in-practice note.
- `slash-commands.tsx:541-572` — a **Tiptap `Suggestion` plugin** `onKeyDown` callback (not a
  raw `addEventListener`), active only while the `/` menu is open: `ArrowDown/Up` (cycle),
  `Enter` (run selected command), `Tab` (dismiss, but explicitly lets Tab's own default focus
  behavior continue — `return false` after `destroy()`), `Escape` (dismiss). Returning
  `true`/`false` from this callback is Tiptap's own consume/pass-through contract, not a DOM
  `stopPropagation()` call.

### 1.7 Titlebar (V2) — `components/titlebar/titlebar.tsx`

Gated on `USE_V2_TITLEBAR = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"` (`:62`) — i.e.
**live in the default/beta channel**, dormant only in `prod` channel builds. See §0.1/§0.2/§0.3
for the `mod+w` capture-phase listener (`:326-338`) and the registry-side `common.goBack/
goForward` (`:144-156`), `tab.prev`/`tab.next` (`:346,363`), `tab.1..9` (`:376-391`)
registrations. No keyboard handling exists in the legacy (`!USE_V2_TITLEBAR`) branch
(`:497+`) — confirmed by grep, only one `command.register` call site total plus the one inside
the V2 `<Match>` block.

### 1.8 Session-level document keydown — `pages/session.tsx` + `pages/session/session-keydown.ts`

`session-keydown.ts` (pure classifier, no DOM binding): `isEditableTagName` (`:7-9`);
`classifySessionKeydown` maps `PageUp/PageDown/Home/End` → `"scroll-gesture"` (`:31-33`), any
single printable character with no ctrl/meta → `"focus-input"` (`:34-36`), else `"ignore"`
(`:37`). Consumed by `session.tsx:885`.

`session.tsx:862-894`, wired `document.addEventListener("keydown", handleKeyDown)` at `:1262`
(bubble phase, mounted `onMount`, removed `onCleanup` `:1287`): bails on `[data-prevent-autofocus]`
regions or editable targets — both via `composedPath()` (`:863-870`) and via a shadow-DOM-aware
`deepActiveElement()` walk (`:849-860,872-876`); bails if any dialog is active (`:877`); if the
composer input is already focused, `Escape` blurs it (`:879-882`); otherwise classifies via
`session-keydown.ts` and either marks a scroll gesture or **redirects typing into the composer**
by focusing it (`:885-894`) — this is the "type anywhere to start typing your prompt" behavior.
**Never calls `preventDefault`/`stopPropagation` anywhere in this handler.**
`message-timeline.tsx:1507-1509` calls `event.stopPropagation()` first, specifically to shield
its own inline session-title-rename input from this global handler.

### 1.9 Dock header disclosure toggles — `Enter`/`Space` pattern (4 near-identical sites)

Same micro-pattern, independently implemented in each file (not shared code): `role="button"
tabIndex={0}` header → `onKeyDown` checks `event.key === "Enter" || event.key === " "` →
`preventDefault()` → toggle.
- `pages/session/composer/session-followup-dock.tsx:42-46`
- `pages/session/composer/session-revert-dock.tsx:41-45`
- `pages/session/composer/session-todo-dock.tsx:110-114`
- `claxedo-ui/navigation-islands/navigation-row.tsx:55-59` (no `stopPropagation`)
- `claxedo-ui/navigation-islands/terminal-surface-navigation.tsx:111-116` (nested inside a
  `NavigationRow`; **does** call `stopPropagation` specifically to stop the outer row's own
  Enter/Space activation from double-firing)
- `claxedo-ui/rail/rail-sidebar.tsx:2025,2281,2408` — all three delegate to a shared helper,
  `activateDisclosureFromKeyboard` in `claxedo-ui/rail/rail-sidebar.logic.ts:119-127` (built on
  `isDisclosureToggleKey` at `:115-117`) — this one *is* factored out, unlike the others above.

`session-question-dock.tsx` has a materially richer version of this pattern — not just
Enter/Space — via a dedicated pure classifier:
- `session-question-dock-nav.ts` (pure, no DOM binding): `Escape` → reject (`:94`); `mod+Enter`
  non-repeat → submit (`:96-99`); (bails to `"none"` if editing or not inside the options list,
  or if alt/ctrl/meta held without being the mod+Enter case, `:102-104`); `ArrowDown/Right` →
  move +1 (`:106`); `ArrowUp/Left` → move -1 (`:107`); `Home`/`End` → jump to first/last
  (`:108-109`); respects `event.defaultPrevented` as an early bail (`:92`).
- Consumed by `session-question-dock.tsx:318-347` (`nav`, wired `:426`), plus a second,
  textarea-scoped handler for the custom-answer field (`:546-557`: `Escape` cancels edit,
  `mod+Enter` deliberately left unhandled so it bubbles to the outer `nav` handler, plain
  `Enter` commits, `Shift+Enter` left alone for newline).

### 1.10 Rail-sidebar / navigation-row / terminal-surface-navigation — see §1.9 (folded in above)

### 1.11 File-tree ARIA tree navigation — `components/file-tree.tsx` + `file-tree-helpers.ts`

Pure chord table in `file-tree-helpers.ts:103-131` (`resolveTreeKeyAction`): `ArrowDown/Up` →
move focus ±1 (clamped); `Home`/`End` → jump to first/last; `ArrowRight` → expand (if collapsed)
or move +1 (if already expanded) or no-op (file row); `ArrowLeft` → collapse (if expanded) or
move -1; anything else → none. DOM wiring: `handleTreeKeyDown` (`file-tree.tsx:202-218`), wired
`onKeyDown={level === 0 ? handleTreeKeyDown : undefined}` at `:433` — **only the root-level
`FileTree` instance has a listener**; nested instances rely on bubbling up to the root (comment
at `:197-198` notes this is intentional, so no `stopPropagation`). This is the pure-function-half
of what W7 in the Wave-2 waiver ledger (`2026-07-10-002-...-lld.md:530-531`) already flagged as
covered-but-the-DOM-adapter-untested — still true post-B2, unrelated to WP-C2's chord-collision
scope but relevant to its "collision detection test enumerating the full binding surface" step
(this file needs to be in that enumeration).

### 1.12 Workspace-panel resize-by-keyboard — `claxedo-ui/workspace-panel/workspace-panel.tsx`

`resizeByKeyboard` (`:145-167`), wired `onKeyDown={resizeByKeyboard}` at `:272` on a `role=
"separator" tabIndex={0}` ARIA splitter handle (`aria-orientation="vertical"`, `aria-label=
"Resize workspace panel"`): `ArrowLeft` widens (+24px, anchored right), `ArrowRight` narrows,
`Home`/`End` jump to min/max width. `preventDefault()` only for matched keys (`default: return`
short-circuits before reaching it for everything else). Focus-scope: the splitter handle only,
only rendered when `open() && props.state.mode && !isMobile()`.

`claxedo-ui/workspace-panel/workspace-files-navigator.tsx:194-198` — separately, `Escape` on the
search/filter `<input>` clears the search text; no preventDefault/stopPropagation.

### 1.13 Review-tab diff-style toggle — `claxedo-ui/components/review-workspace/review-tab.tsx`

`:624-640`, wired `window.addEventListener("keydown", onKeyDown)` at `:639` (bubble, global,
`onCleanup` at `:640`): bare `d`/`D` (no ctrl/meta/alt) toggles diff view between `"split"`/
`"unified"` (`:625-626,636`). Guards: standard editable-target check (`:627-631`) **plus** a
visibility check that looks up `#review-panel` in the DOM and bails if it's `aria-hidden` or has
a zero-size bounding rect (`:632-635`) — i.e. even though the listener is globally mounted, it
self-disables when its own panel isn't visible on screen, a pattern none of the other global
listeners in this inventory use.

### 1.14 Browser-pane — `browser/components/browser-pane.tsx`

Hosts a real Electron `<webview>` (guest content runs in a separate renderer process; native key
events consumed inside the guest page do not bubble to the host `window` listener below — no
`before-input-event`/IPC forwarding of guest keys exists in this file).
- `BrowserPaneKeyboardHandlers`'s `onKey` (`:238-259`), wired `window.addEventListener("keydown",
  onKey)` at `:255`, mounted unconditionally whenever a `BrowserPane` is up (`:186`, no
  focus/visibility gate): `Escape` only — exits inspect mode, else clears the
  last-selected-element card, else no-op (`:240-253`). **No preventDefault/stopPropagation.**
- A second, component-local `Escape`/`Enter` handler on the address-bar `<input>`
  (`:537-547`): `Enter` commits navigation (`preventDefault`); `Escape` reverts the draft URL
  and blurs (**no** preventDefault — relies on native blur). These two Escape handlers are
  independent and both fire on the same keypress when the address bar has focus (no functional
  conflict since they touch unrelated state — draft URL vs. inspect-mode — but worth folding
  into one dispatch path during migration for consistency's sake).

### 1.15 Dialogs — release-notes / select-server / network-policy

- `components/dialogs/release-notes.tsx:45-61,69` — `Escape` (close), `ArrowLeft`/`ArrowRight`
  (paged nav), on the dialog root `div[tabIndex=0] autofocus`. `preventDefault` on all three, no
  `stopPropagation`.
- `components/dialogs/select-server.tsx:114-124`, wired on 4 separate text fields
  (`:140,150,160,169`) — `Escape` (back), `Enter` non-IME (submit). **Unconditional
  `stopPropagation()`** on every keydown before any key check (`:115`) — so keystrokes in these
  fields never reach any ancestor listener, including the command-registry's document listener.
- `components/settings/network-policy.tsx:45-51,61` — `Escape` traps focus out of an inline
  (non-portal) overlay, explicit comment documents the intent (`:1-7`); a second, simpler site
  at `:281-283` — `Enter` on the add-entry input submits, no preventDefault/stopPropagation.
- `components/dialogs/select-model-unpaid.tsx:36-46` — `Escape` explicitly `return`s (lets the
  Dialog's own escape-to-close handle it); everything else forwarded to the embedded `List`
  component's own arrow-key navigation.

### 1.16 Settings > Keyboard Shortcuts remap UI — `components/settings/keybinds.tsx`

This is the **existing partial answer** to WP-C2's "discoverability surface" requirement — it
already exists, is already wired to the same `settings.keybinds` override map every other
system's `bind()`/`keybindConfig()` reads from, and already does real (if narrow) collision
detection:
- `useKeyCapture` (`:204-257`), wired `makeEventListener(document, "keydown", handle, {capture:
  true})` at `:256` — **capture phase**, `preventDefault()`+`stopPropagation()`+
  `stopImmediatePropagation()` unconditionally the instant a rebind capture is active
  (`store.active !== null`, `:206-211`), pre-empting every other listener in this inventory
  while a rebind is in progress (belt-and-suspenders: `settings.tsx`'s `command.keybinds(false)`
  also increments `suspendCount` on the command registry, `command-palette.tsx:437-439`, so
  `handleKeyDown` short-circuits too).
- `Escape` cancels capture (`:213-216`); `Backspace`/`Delete` with no modifiers clears the
  binding to the sentinel `"none"` (`:218-227`, **exempt from collision checking**); any other
  key builds a chord signature (`recordKeybind`, `:77-95`) and checks it against `used()`
  (`:322-358`, a memo of every *other* command's currently-effective keybind signature, built
  from custom overrides where present else the live-registered default) — on collision, shows a
  toast naming the conflicting command(s) and **refuses to save**; otherwise persists via
  `settings.keybinds.set(id, keybind)` (`:360`) into `Settings.keybinds`, a flat `Record<string,
  string>` (`context/settings.tsx:45`, default `{}`), persisted under the whole-settings blob
  key (`utils/persist.ts` → `localStorage["opencode.settings.v3"]` on web,
  `platform.storage()` on desktop).
- **What this collision check does NOT catch**: it only compares against commands that are
  *listed in this settings UI* (i.e., registered through `context/command.tsx`/
  `command-palette.tsx` with a visible/known id) — it has no visibility into `terminal/backend/
  keyboard.ts`'s xterm-level chords, `editor-keymap.ts`'s prompt-editor chords, `page-editor.tsx`'s
  ProseMirror/Tiptap chords, `titlebar.tsx`'s `hidden: true` commands (unclear if hidden commands
  are excluded from `used()` — not verified either way in this pass, flag for whoever implements
  WP-C2's collision test), or `workbench.tsx`'s hardcoded `resolveKeyMap()` defaults (it can only
  ever detect a *new* collision the user is about to create with another *registry* command, not
  the pre-existing ones documented in §2 below). This is exactly the gap WP-C2's "collision
  detection test enumerating the full binding surface" is scoped to close — `rail-keyboard-
  commands.test.ts` (§1.3) is the only existing precedent, and it only compares two of the
  ~10 systems in this inventory.

### 1.17 Desktop-only, outside `packages/claxedo-app` — flagged because it changes §5's analysis

- `packages/claxedo-app/src/desktop-menu.ts` — a generic `DesktopMenuItem[]` structure (`type`,
  `label`, `command`, `action`, `role`, `accelerator: {macos, windows}`) consumed by
  `components/windows-app-menu.tsx:38-39` (`runCommand(entry.command)` → `props.command.trigger(id)`,
  i.e. **this path does go through the real command registry**, so its ids are trustworthy —
  `fileTree.toggle`, `terminal.toggle` (dead per §0.4), `common.goBack/goForward` verified
  live; `settings.open`, `logs.export`, `session.previous/next`, `project.open/previous/next`,
  `sidebar.toggle` have no matching registered command id anywhere in the tree — dead on
  Windows/Linux too, not just macOS).
- `packages/claxedo-desktop/src/main/menu.ts` (13-137 lines, outside this package) builds the
  **native macOS Electron application menu** independently, with its own hardcoded accelerator
  strings and `deps.trigger(id)` calls (wired at `packages/claxedo-desktop/src/main/index.ts:344-345`
  to `sendMenuCommand(mainWindow, id)`, an IPC round-trip into the renderer's `command.trigger`).
  This file has **drifted from the live command-id set**: `"Cmd+W"` → `trigger("claxedo.tab.close")`
  (no such id — real is `tab.close`, `use-session-commands.tsx:199`), `"Cmd+B"` →
  `trigger("sidebar.toggle")` (no such id — real is `claxedo.sidebar.toggle`,
  `rail-keyboard-commands.ts:49`), `"Cmd+\\"` → `trigger("claxedo.split.toggle")` (no such
  command exists at all — the real `mod+\` split behavior lives entirely in the workbench's own
  listener, §1.2, which is never a registered *command*), `"Option+ArrowUp/Down"` →
  `trigger("session.previous"/"session.next")` (no such commands anywhere), `"Cmd+O"` →
  `trigger("project.open")` (no such command). By contrast `"Shift+Cmd+S"` → `session.new`,
  `` "Ctrl+`" `` → `terminal.toggle` (dead per §0.4, but at least the id matches the (nonexistent)
  contract consistently with `desktop-menu.ts`), `"Cmd+["`/`"Cmd+]"` → `common.goBack/goForward`,
  and the unaccelerated `fileTree.toggle` are all consistent with real registered ids.

---

## 2. Collision table

| Chord | Systems bound (file:line) | What wins today | Why |
|---|---|---|---|
| `mod+w` | (a) `use-session-commands.tsx:201` `tab.close` (registry, `document` bubble); (b) `workbench.tsx:157` `closePane` (`window` bubble); (c) `titlebar.tsx:326-338` V2 capture listener (`document` capture, `USE_V2_TITLEBAR` only); (d) `rail-keyboard-commands.ts` `claxedo.pane.close` — **keybind already removed by B2**, palette-only, not live here | (c) wins if it closes a session tab (capture + stopPropagation beats everything); else (a) and (b) **both** fire on the same keypress if a file tab is open and a pane is focused (a doesn't stopPropagate) | Capture beats bubble; within bubble, `document` is encountered before `window` in the propagation path, and (a) never calls `stopPropagation` |
| `mod+shift+s` | `use-session-commands.tsx:171` `session.new`; `app-shell-commands.ts:71` `theme.scheme.cycle` | Whichever `command.register()` call mounts/runs first in `command-palette.tsx`'s `keymap` memo (`:336-352`, first-registered-wins, silent) | Same registry, same signature, no duplicate-keybind warning (only duplicate-*id* is warned, `:275-280`) |
| `mod+1`..`mod+9` | `rail-keyboard-commands.ts:55-61` `claxedo.surface.N` (switch workbench surface); `titlebar.tsx:376-391` `tab.N`, `hidden:true`, `USE_V2_TITLEBAR` only (jump to Nth session tab) | First-registered-wins, silent; titlebar's version is invisible in the palette (`hidden:true`) even if it wins | Same registry, same signature |
| `mod+alt+ArrowLeft`/`Right` (== `mod+option+ArrowLeft`/`Right`, `command-palette.tsx:138-140` treats alt/option as the same flag) | `workbench.tsx:177-193` `focusLeft/Right` (geometric pane focus, `window` bubble); `titlebar.tsx:346,363` `tab.prev/next`, `hidden:true`, `USE_V2_TITLEBAR` only (session-tab cycling, registry `document` bubble) | Both fire (workbench doesn't stopPropagate; document-before-window ordering means titlebar's registry handler runs first but doesn't stop propagation either) | This is the audit's original "two systems" finding — B2 closed the `rail-keyboard-commands.ts` half, but `titlebar.tsx` independently re-opened the registry side of the same chord family |
| `mod+u` | `editor-keymap.ts:55-60` (prompt-editor local, file-attach picker, only in `mode()==="normal"`); `mode-commands.ts:35` `file.attach`-family registry entry (one of 3 `EDITABLE_KEYBIND_IDS`) | Editor-local handler runs first (element `onKeyDown` fires before it would bubble to `document`); registry entry exists specifically so `mod+u` also works when focus is elsewhere | Not a bug — `EDITABLE_KEYBIND_IDS` exists precisely to let this one overlap safely — flagged for awareness, not for the "must fix" list |
| `` Ctrl+` `` | `terminal/backend/keyboard.ts:100-102` (explicit pass-through, returns `true`); intended registry command `terminal.toggle` | Nothing — no command with id `terminal.toggle` exists (§0.4) | Gap, not a collision: the pass-through has no receiver |
| `Escape` inside page-editor overlays (AI composer, link input) | `page-editor.tsx:604` window **capture** listener (wins); `page-editor-overlay.tsx:74`, `page-editor-toolbar.tsx:227` component-local bubble listeners (dead in practice) | Capture-phase handler always wins first | Not a bug per se (both branches do the same thing — close the overlay) but the component-local handlers are unreachable dead code for `Escape` specifically |
| `Cmd+W` / `Cmd+B` / `Cmd+\` / `Option+↑↓` / `Cmd+O` on real macOS Electron desktop | `packages/claxedo-desktop/src/main/menu.ts` native accelerators dispatching to nonexistent command ids (§1.17) | OS-level accelerator consumes the keypress; renderer never sees it; the target command doesn't exist, so **nothing happens** | Native-menu/renderer id drift — see §5, this is the load-bearing finding for W9 |

## 3. Per-system migration difficulty (to one command-registry-backed dispatch path)

- **Rail keyboard commands (`rail-keyboard-commands.ts`) — trivial.** Already command-registry
  entries; only the `keybind`-omitted ones need a decision (§5), not a mechanism change.
- **App-shell / session / titlebar registry registrations (§1.1's list) — trivial**, they're
  already in the registry; the work here is de-duplication (drop or re-key the
  `mod+shift+s`/`mod+1..9`/`mod+alt+Arrow` collisions from §2), not migration.
- **Workbench listener (`workbench.tsx` + `keyboard.ts`) — mechanical, with one design
  decision.** The four chords (`closePane`, `splitRight/Down`, `focusLeft/Right/Up/Down`) map
  cleanly onto command semantics that already exist as registry actions elsewhere
  (`claxedo.pane.close`, `claxedo.split.focusLeft/Right` have no Up/Down equivalents yet — a gap
  to fill, not a blocker). The decision needed: does the registry's `matchKeybind`/`parseKeybind`
  (`command-palette.tsx`) fully subsume `workbench/keyboard.ts`'s looser `matchKey` (`needMod`
  accepts either ctrl or meta regardless of platform, `keyboard.ts:25`, vs. the registry's
  platform-aware `mod`), or does dropping that looseness change observable behavior on Windows/
  Linux where a stray `metaKey` could currently match? Needs an explicit behavior call, not just
  a mechanical port.
- **Dock header disclosure toggles (§1.9), file-tree ARIA nav (§1.11), workspace-panel resize
  (§1.12) — do not migrate.** These are element-scoped `Enter`/`Space`/`Arrow`/`Home`/`End`
  activation patterns on custom ARIA widgets (`role="button"`, `role="separator"`,
  `role="tree"`), not global app shortcuts. They're a11y-pattern implementations, not
  "commands" in the WP-C2 sense — migrating them to a global keydown-matching registry would be
  a regression (it would require re-deriving DOM-local focus/target context the registry
  doesn't currently model). Leave them; at most, factor the 4 near-duplicate Enter/Space
  snippets in §1.9 into one shared helper (already half-done via
  `rail-sidebar.logic.ts:activateDisclosureFromKeyboard`) as a drive-by cleanup, not a WP-C2
  registry migration.
- **`editor-keymap.ts` / page-editor Tiptap chords / terminal xterm handler — design-decision-
  needed, likely "do not migrate wholesale."** See §4 — most of these chords are contextual to
  editor/terminal internal state machines (IME composition, popover navigation, caret position,
  PTY byte forwarding) that the command registry has no model for today. The two terminal
  chords that *are* app-level (`Cmd+D`/`Cmd+Shift+D` split) and the composer's `mod+u` could be
  re-expressed as registry commands invoked from inside the local handler (call `command.trigger(id)`
  instead of duplicating logic) without moving the whole local keymap — that's the realistic
  scope, and it should be scoped explicitly rather than assumed.
- **Settings > Keybinds UI (`keybinds.tsx`) — extend, don't replace.** Already the
  discoverability + remap + narrow-collision-detection surface the LLD asks for; the work is
  widening its `used()` collision set to see every system in this inventory (or, more
  realistically, defining which systems even *have* remappable ids — the xterm/editor-local
  chords likely stay out of this UI's scope per the "do not migrate" list in §4, in which case
  the UI's current scope is already close to correct and mainly needs the registry-side
  collisions in §2 fixed so it isn't shipping known-broken defaults).
- **`desktop-menu.ts` (Windows/Linux) — mechanical fix, not a migration.** Already routes
  through the registry (`windows-app-menu.tsx:39` → `command.trigger`); just needs its dead
  command-id strings corrected to match real ids (§1.17).
- **`packages/claxedo-desktop/src/main/menu.ts` (native macOS) — outside `claxedo-app`, but
  blocking.** Same fix as above (correct the 5 drifted ids), plus — because this file
  duplicates a hand-maintained accelerator string next to a hand-maintained command id with no
  shared source of truth — consider (design decision, not this pass's call) generating this
  template from the same registry catalog `command-palette.tsx:255-308` already persists, so
  drift like this is structurally impossible going forward. Flagged, not decided.

## 4. Bindings that must NOT migrate to the command registry

- **All ProseMirror/Tiptap-internal keystrokes in `page-editor.tsx`** (formatting, list/indent,
  native cursor movement, IME composition) — owned entirely by Tiptap/`StarterKit`'s own keymap;
  the registry has no ProseMirror transaction context and re-implementing this would be a
  from-scratch rich-text-editor keymap rewrite, not a "migration."
- **`terminal/backend/keyboard.ts`'s PTY-forwarding chords** (`Shift+Enter`, `Cmd/Ctrl+Backspace`,
  Mac `Option+Arrow` word-nav, `Cmd/Ctrl+Arrow` line-nav, `Ctrl+C`) — these write raw
  terminal escape/control bytes (`\x15\x1b[D`, `\x1bb`, `\x01`, `\x03`, etc.) directly to the PTY
  via xterm's `attachCustomKeyEventHandler`. They are not "commands" in any app sense; they're
  terminal-emulation semantics that must stay co-located with the xterm instance and fire before
  xterm's default handling, which a `document`/`window`-level registry listener structurally
  cannot do (xterm needs the chance to *not* forward the key to the shell, which only
  `attachCustomKeyEventHandler`'s `false` return achieves).
- **`editor-keymap.ts`'s IME-composition guard, popover arrow-nav, and history navigation**
  (`event.isComposing`/`deps.isImeComposing` gating; `ArrowUp/Down` routed to
  `atOnKeyDown`/`slashOnKeyDown` while a mention/slash popover is open; caret-position-gated
  prompt-history `ArrowUp/Down`) — these depend on live DOM caret state and a11y-popover-list
  state that only exist inside the mounted prompt editor; genuinely reusable pieces
  (`mod+u`, `Ctrl+G`) can trigger through the registry, but the ArrowUp/Down/IME logic cannot be
  hoisted without breaking IME input for CJK/other composing input methods.
- **`session-question-dock-nav.ts`'s option-list navigation** (`ArrowUp/Down/Left/Right`,
  `Home`/`End`, gated on `context.inOptions`/`context.editing`) — a bespoke ARIA
  listbox-navigation pattern scoped to one dock's DOM subtree, same reasoning as file-tree §1.11.
- **File-tree ARIA tree nav, workspace-panel resize-by-keyboard, and all `Enter`/`Space`
  disclosure-toggle sites (§1.9, §1.11, §1.12)** — element-scoped ARIA-widget activation
  patterns, not app-level commands; see §3.
- **`select-server.tsx`'s per-field `Escape`/`Enter` with unconditional `stopPropagation`** and
  **`network-policy.tsx`'s focus-trapped overlay `Escape`** — deliberately-scoped dialog-local
  form UX, not shortcuts a user would look up in a palette.
- **`browser-pane.tsx`'s webview-hosted content** — keys consumed inside the Electron
  `<webview>` guest process are architecturally invisible to the host renderer's registry; only
  the host-chrome-level `Escape` (inspect mode / selection) and address-bar `Enter`/`Escape`
  are in scope for this package at all, and even those are host-page-focus-scoped UI, not
  discoverable app commands.

## 5. `mod+w` desktop-quit reachability (W9) — proposed C2-era resolution

**Current state, restated precisely.** `rail-keyboard-controller.tsx:22-45`'s `closeFocusedPane`
contains the only "Quit Claxedo?" dialog in the tree (`platform.platform === "desktop"` branch,
`:27-40`, gated on zero alive contents remaining). It is reachable in two ways today: (1) via
the palette/voice/remote path, since `claxedo.pane.close` is still a registered — just
keybind-less — command (`rail-keyboard-commands.ts:16-26`); (2) via keyboard **only** if
something dispatches `mod+w` all the way to whatever eventually calls this function — and
per §0.1/§0.2/§2's `mod+w` collision entry, on the actual renderer DOM, `mod+w` is claimed by
`workbench.tsx`'s `closePane` (which calls `wb.split.close`, a different, pane-scoped code path,
**not** `rail-keyboard-controller.tsx`'s `closeFocusedPane`) before it would ever reach this
function through any chord dispatch. In other words: **even setting aside the e2e-web-tier
`platform:"web"` hardcoding the fixme ledger already named, the desktop Quit dialog's own
`closeFocusedPane` implementation is not the function `mod+w` calls on the renderer side at
all** — `workbench.tsx`'s listener is. And on *real* macOS Electron desktop specifically, `mod+w`
never even reaches the renderer: it's claimed by the native OS menu accelerator
(`packages/claxedo-desktop/src/main/menu.ts`, `"Cmd+W"` → `trigger("claxedo.tab.close")`), which
— per §0.5/§1.17 — dispatches to a command id that doesn't exist, so the keypress currently does
**nothing at all** on macOS desktop, not "opens the wrong dialog" but "silently swallowed by the
OS menu layer before any JS keydown handler runs." (This last claim is static-analysis-derived —
grep confirms no `claxedo.tab.close` registration exists and confirms Electron's accelerator
IPC path — but has not been verified by launching the actual Electron app; flagged as
high-confidence, not live-verified, per repo convention.)

**Proposed C2-era resolution:**
1. Fix the native macOS menu's drifted command ids first, as a prerequisite, independent of the
   registry-consolidation work (`claxedo-desktop/src/main/menu.ts`: `"claxedo.tab.close"` →
   `"tab.close"`, `"sidebar.toggle"` → `"claxedo.sidebar.toggle"` — this alone makes `Cmd+W` on
   macOS desktop start reaching a real command again, namely the file-tab-close command, not the
   pane-close/quit path). This is a one-line-per-id fix, no design decision, and should land
   regardless of what WP-C2 decides for the rest of `mod+w`.
2. Make `mod+w` semantics a single, explicit, focus-scope-ordered decision instead of an emergent
   accident of listener-mount-order: **file tab open → close file tab; else pane has other
   content and can be closed without emptying the workbench → close pane; else (last pane, last
   content, desktop platform) → show the Quit dialog.** This is exactly the fallback chain that
   already exists piecemeal across `use-session-commands.tsx`'s `tab.close`,
   `workbench.tsx`'s `closePane`, and `rail-keyboard-controller.tsx`'s `closeFocusedPane` — the
   WP-C2 registry consolidation should make it one command (`claxedo.pane.close`, already the
   right id and already home to the Quit-dialog logic) that internally tries the file-tab-close
   step first, then falls through, rather than three separately-triggered handlers racing on
   event propagation order.
3. Once `claxedo.pane.close` is the single owner and *does* get a `keybind: "mod+w"` again, add
   it to `rail-keyboard-commands.test.ts`'s (or its WP-C2 successor's) collision-detection set
   checked against `workbench.tsx`'s `resolveKeyMap()` **and** against `use-session-commands.tsx`'s
   `tab.close` **and** against `titlebar.tsx`'s registrations — i.e. the new test must enumerate
   every `command.register()` call site in the tree, not compare two hand-picked sources, or
   this exact class of regression (a fourth call site nobody thought to check) recurs.
4. Keep the V2 titlebar's capture-phase `mod+w` listener (`titlebar.tsx:326-338`) as the outermost
   layer *only if* its session-tab-close semantics stay conceptually prior to file-tab/pane-close
   (i.e. "close whatever's most specific to what's currently visible" — session tab, then file
   tab, then pane, then quit) — but that ordering should be written down as the decision, and the
   capture-phase interception should call into the same single `claxedo.pane.close` command
   (with a "there's nothing more specific to close" signal) rather than short-circuiting past it
   silently the way it does today.
5. This makes the desktop last-pane Quit dialog reachable via keyboard again (both on real macOS
   desktop, once step 1 lands, and via the renderer-level `mod+w` chord once steps 2-3 land), and
   makes `core-panes-split-tabs:580`'s `test.fixme` flippable — but flipping it requires an
   Electron-launched (not web-Playwright-tier) test harness, since the whole point of this
   analysis is that the behavior lives in `packages/claxedo-desktop`, which the current e2e tier
   (`platform:"web"` hardcoded per the fixme's own citation) cannot reach. That harness gap is
   pre-existing and out of WP-C2's scope to fix, but worth naming so whoever picks up W9 doesn't
   assume a web-tier Playwright fix is sufficient to close it.
