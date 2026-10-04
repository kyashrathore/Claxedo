# Codex Session Errors — Classification, Placement & Copy

Reverse-engineered from the Codex desktop app (ChatGPT.app `2026-07-18` build, Electron webview,
React 19 + Tailwind v4 + jotai + framer-motion). Sources: minified bundles extracted from
`app.asar` (`webview/assets/*`, 4879 files), the thread-page CSS, the unminified Codex protocol
types vendored in this repo at `packages/agent-event-runtime/src/harnesses/codex/protocol/v2/**`,
and live rollout data under `~/.codex/sessions`.

Companion to [`CODEX_TIMELINE_DESIGN.md`](./CODEX_TIMELINE_DESIGN.md) (cited as **D§n**), which
specifies the *success* path. This document specifies the *failure* path: what Codex classifies,
where it puts each kind, what it says, and when it refuses to say anything at all.

Byte offsets reference the extracted bundles; class strings and copy are verbatim. Every
unverifiable claim is marked **UNVERIFIED**.

**Bundle shorthands** (all under `webview/assets/`):

| tag | file |
|---|---|
| `THREAD` | `local-conversation-thread-Bnxyo76e.js` (301 KB) |
| `PAGE` | `local-conversation-page-VUpHHoMJ.js` (107 KB) |
| `STORE` | `app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~business-checkout~oxnpxkxc-D1ceIDrn.js` |
| `RENDER` | `app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~c33rimzq-BCpF88Ln.js` (806 KB) |
| `COMPOSER` | `app-initial~app-main~settings-command-menu-section-items~new-thread-panel-page~settings-pag~unq8yzli-BVneZysG.js` (711 KB) |
| `EXEC` | `app-initial~app-main~new-thread-panel-page~onboarding-page~hotkey-window-thread-page~quick-~e9bovb3h-BAFL-yHh.js` |
| `CONN` | `app-initial~app-main~projects-index-page~chatgpt-conversation-page~remote-connections-setti~ih6lkeby-Ke_o1Sl3.js` |
| `BTN` | `app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~jhj9i1pn-EyBx1hQI.js` |
| `SHELL` | `app-initial~avatarOverlayCompositionSurface~artifact-tab-content.electron~app-main~plugin-d~kw7nl1sl-IKjhUium.js` |
| `ANIM` | `app-initial~app-main~page~pull-request-route~onboarding-page~appgen-library-page~hotkey-win~lehncapg-D3sAMNRw.js` |
| `CSS` | `app-B6aXltj2.css` (613 KB) |

---

## 1. Design philosophy of failure

Six principles explain every placement decision below. They are *not* what the brief assumed, and
the difference matters — see §1.1.

1. **Failure is a word, not a colour.** In the transcript, a failed tool row differs from a
   successful one only in its verb: `Ran` → `Stopped`, `Approved` → `Denied`, `Created` →
   `Failed to create`. Wrapper, icon, text colour, hover lift, background, border — all identical.
2. **Failure is never louder than success.** The exec footer gives success a checkmark glyph and
   failure *no icon at all*. Codex repeatedly spends less visual budget on the error state than on
   the happy state.
3. **`tone="muted"` is the declared tone for error states.** Not a metaphor — Codex literally
   passes `tone="muted"` to error rows (`THREAD @ 169931`).
4. **Colour is a glyph budget, never a chrome budget.** Where red appears in the conversation area
   at all, it is a 16px `currentColor` glyph on an otherwise muted row. Colour-as-chrome (fills,
   borders, rails) is quarantined to settings dialogs and dropdowns — surfaces outside the reading
   experience.
5. **Terminal states are dividers.** Aborts, auto-review stops, and hard billing walls all resolve
   to a centred label between two 8%-opacity hairlines — the same shell as `Worked for 1h 22m 5s`
   (D§3.6).
6. **Placement is decided by *actionability*, not by timing.** This is the load-bearing rule and
   the one most likely to be mis-copied.

### 1.1 The rule the brief got wrong: actionability, not preflight

The research brief hypothesised that Codex hoists *pre-send-knowable* failures to a composer
surface and leaves *mid-turn* failures inline. **That is not the axis.** Two findings refute it:

- **Codex performs no auth, model, quota, or entitlement preflight whatsoever.** The composer's
  19-member block cascade (§5.2) contains zero account-shaped members. Quota is discovered
  *reactively*, from the failing turn: an `error` notification carrying `usageLimitExceeded`
  invalidates the `["rate-limit-status"]` query, which then paints a banner (`STORE @ ~682000`).
  The composer stays enabled the entire time.
- **Codex renders bare error rows directly under user bubbles**, exactly the shape the brief
  objects to. `stream-error` and `system-error` are first-class renderable row kinds
  (`RENDER @ 27925`, `@ 31958`), and a terminal error on a turn that produced no output is
  explicitly *lifted out* of the collapsible fold so it sits immediately below the bubble
  (`…c1415s9d-CLDrD9B1.js @ 8387`).

The actual axis is **whether there is a concrete thing the user can do**:

| | Actionable | Not actionable |
|---|---|---|
| **Knowable before send** | Composer-adjacent banner **with CTA** + block Send (worktree gone, sandbox missing, SSH down) | — |
| **Only knowable after send** | Composer-adjacent banner **with CTA** (quota, bio/cyber policy) | Quiet transcript row, text only (stream errors, unclassified server faults) |

The bio/cyber-policy block is the proof: it is *only* knowable after the server reads the prompt,
yet it is hoisted to a composer banner — because there is a real next step ("Continue with GPT-5.6
Terra", "Learn more"). Meanwhile `usageLimitExceeded` appears in *both* places, with a clean
division of labour: the transcript row explains **what happened to this turn** (text only, no
buttons); the composer banner carries **what to do about it** (CTAs).

### 1.2 The strongest single datum

The React error boundary for a whole crashed turn — the most severe failure the UI can represent —
`THREAD @ 247907`:

```jsx
<div className="rounded-lg border border-token-border bg-token-main-surface-primary
                px-4 py-3 text-sm text-token-text-secondary">
  <div className="mb-2 font-medium text-token-text-primary">This turn couldn't render</div>
  <Button color="secondary" size="default" onClick={onRetry}>Try again</Button>
</div>
```

`border-token-border` = `#ffffff14` (8% white). Not `border-token-border-error`. A hard render
crash gets neutral chrome and a button.

---

## 2. The colour finding, stated precisely

**There is no coloured left rail anywhere in Codex.** Not in the transcript, not in settings, not
in dialogs. Exhaustive scan over all 4879 bundles:

```
grep -ohE 'border-l-[0-9]? ?[^ `"]*(red|error|danger)[^ `"]*' *.js   →   (no output)
```

Usage census of error tokens inside `THREAD` (301 KB — the *entire* local conversation surface):

| class string | occurrences in `THREAD` |
|---|---|
| `text-token-text-error` | **0** |
| `text-token-icon-error` | **0** |
| `border-token-border-error` | **0** |
| `bg-token-background-status-error` | **0** |
| `text-token-error-foreground` | **1** — a *settings dialog* |
| `text-token-charts-red` | 2 — both *side-panel git rows* |

Codex ships a complete error token system (§4) and the conversation transcript consumes
essentially none of it.

**The restraint is deliberate, not an oversight.** The composer's banner shell exposes a
`backgroundColorClassName` escape hatch for exactly this purpose — and no caller anywhere in the
app passes it:

```
grep -ohE 'backgroundColorClassName:[^,}]{0,60}' *.js  →  backgroundColorClassName:o   (the destructure itself, only)
```

The tinted-banner capability exists and is used zero times.

---

## 3. Element inventory & states

### 3.1 Tool-activity rows — the verb *is* the signal

Row summaries are ICU messages with two custom tags whose renderers carry **no colour class at
all** (`RENDER @ 705225`, `@ 705316`):

```js
function JR(e){return jsx(`span`,{className:`min-w-0 truncate`,children:e},`detail`)}
function YR(e){return jsx(`span`,{className:`whitespace-nowrap`,children:e},`action`)}
```

Colour is inherited wholly from the row parent (`RENDER @ 702007`):

```
block min-w-0 max-w-full flex-1 truncate text-token-conversation-body
  [&_*:not(button)]:!text-token-conversation-body
group-hover/activity-header:!text-token-foreground
  group-hover/activity-header:[&_*:not(button)]:!text-token-foreground
```

So `<action>Denied</action> <detail>request</detail>` renders **byte-identically in style** to
`<action>Ran</action> <detail>npm test</detail>`.

**The complete tool-activity catalog** (`RENDER @ 33000–40500`) — every summary the transcript can
show for a tool call:

```
<action>Reading</action> <detail>{target}</detail>
<action>Reading</action> <detail>{skillName} skill</detail>
<action>Reading</action> <detail>Internal Knowledge</detail>
<action>Searching</action> <detail>files in {folder} folder</detail>
<action>Searching</action> <detail>for {query}</detail>
<action>Searching</action> <detail>files</detail>
<action>Listing</action> <detail>files</detail>
<action>Listing</action> <detail>files in {folder} folder</detail>
<action>Creating</action> <detail>{path}</detail>
<action>Deleting</action> <detail>{path}</detail>
<action>Editing</action> <detail>{path}</detail>
<action>Searching the web</action>
<action>Searching the web</action> <detail>for {query}</detail>
<action>Approved</action> <detail>request</detail>
<action>Denied</action>   <detail>request</detail>
<action>Stopped command</action>
<action>Stopped</action>  <detail>{command}</detail>
<action>Ran command</action>
<action>Ran</action>      <detail>{command}</detail>
<action>Running command</action>
<action>Running</action>  <detail>{command}</detail>
```

**There is no "Failed" variant for exec.** A command exiting 1 still renders `Ran {command}`.
At rest, a failed shell command is indistinguishable from a successful one; you must expand the
row to learn it failed.

**Success vs failure row anatomy:**

| aspect | success | failure | differs? |
|---|---|---|---|
| row wrapper | `group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1` | same | **no** |
| icon | `icon-xs shrink-0 text-token-conversation-body` | same (1 exception, §3.3) | **no** |
| verb span | `whitespace-nowrap` | same | **no** |
| detail span | `min-w-0 truncate` | same | **no** |
| text colour | `text-token-conversation-body` | same | **no** |
| hover lift | `!text-token-foreground` | same | **no** |
| background / border / rail | none | none | **no** |
| **wording** | `Ran`, `Approved`, `Created` | `Stopped`, `Denied`, `Failed to create` | **yes — the only signal** |
| expanded footer | `Success` + ✓ | `Exit code {n}`, no icon | **yes** |

### 3.2 Exec footer — where the exit status actually surfaces

`EXEC @ 23883`, function `U`. All four states, verbatim:

```jsx
// in progress
<div className="text-size-chat px-2.5 pt-0.5 pb-1" />                       // empty

// interrupted
<div className="text-size-chat flex items-center gap-2 px-2.5 pt-0.5 pb-1
                text-token-input-placeholder-foreground">
  <span className="ml-auto">Stopped</span>
</div>

// success
<div className="text-size-chat flex items-center gap-2 px-2.5 pt-0.5 pb-1
                text-token-input-placeholder-foreground">
  <span className="ml-auto flex items-center gap-1"><CheckIcon className="icon-xxs" /> Success</span>
</div>

// FAILURE
<div className="text-size-chat flex items-center gap-2 px-2.5 pt-0.5 pb-1
                text-token-input-placeholder-foreground">
  <span className="ml-auto">Exit code {code}</span>
</div>
```

Identical class string across all four — including the colour token. Success gets a glyph; failure
gets none. `execFooter.exitCode.unknown` → the literal word `unknown` when no code is reported.

The card container is unchanged by outcome (`EXEC @ 21809`):
`group flex flex-col overflow-hidden rounded-lg border border-token-border-heavy`.

**stderr is not separated from stdout** — the output pane takes a single `output` string. Failure
output looks exactly like success output.

### 3.3 The one icon tint — worktree bootstrap only

`EXEC @ 25281`, the **only** verified icon-tint-on-failure in the conversation area:

```js
function Y(e){
  let {kind:n, status:i} = e,
  a = i===`failed` ? `text-token-editor-error-foreground` : `text-token-conversation-body`,
  o = r(`icon-xs shrink-0`, a);
  switch(n){ case `worktree`: … case `setup`: … case `conversation`: … }
}
```

Tints **only the 16px icon**; the label keeps its muted colour. Applies **only** to session
bootstrap kinds — never to `exec`, `patch`, `web-search`, or MCP calls.

| kind | completed | failed |
|---|---|---|
| worktree | `Worktree created` | `Failed to create worktree` |
| setup | `Environment set up` | `Failed to set up the environment` |
| conversation | `Starting the conversation` | `Failed to start the conversation` |

### 3.4 `stream-error` row — the only debug disclosure in the transcript

`RENDER @ 611167`, component `EI`. With an icon it delegates to the standard activity row (`ch`);
without one it is bespoke:

```jsx
<div className={cn(`group flex min-w-0 items-start gap-1`,
                   expandable ? `cursor-interaction` : `cursor-default`)}
     onClick={toggle}>
  {summary}
  {expandable && <Chevron className={cn(
      `text-token-input-placeholder-foreground icon-2xs mt-0.5 flex-shrink-0
       transition-[opacity,rotate] duration-relaxed opacity-0 group-hover:opacity-100`,
      expanded && `opacity-100`, expanded ? `rotate-180` : ``)}/>}
</div>

// summary
<div className="text-size-chat min-w-0 whitespace-pre-wrap text-token-description-foreground/80">
  {message}
</div>

// expanded body
<div className="mt-1 flex flex-col gap-1">
  <div className="text-size-chat whitespace-pre-wrap text-token-description-foreground/80">
    {additionalDetails}
  </div>
</div>
```

- Gate: `additionalDetails != null && additionalDetails.trim().length > 0`.
- Chevron hidden at rest, `group-hover:opacity-100` — same invisible-affordance rule as D§3.3.
- Chevron is `rotate-180` (caret flip) and `icon-2xs` — *smaller* than the tool-row chevron, which
  uses `rotate-90`.
- Raw detail is **prose** (`whitespace-pre-wrap`), not monospace. No max-height, no scroll
  container, **no copy button**.

Copy, `RENDER @ 609670`/`@ 610471`:

| id | defaultMessage |
|---|---|
| `localConversation.streamError.reconnecting` | `Reconnecting {progress}` |
| `…reconnectingProgressDenominator` | `/{maxAttempts}` |
| `…serverOverloadedReconnecting` | `Server is busy, reconnecting` |
| `…serverOverloadedReconnectingWithProgress` | `Server is busy, reconnecting {progress}` |

`{progress}` is an animated rolling-digit column — the same mechanism as diffstats (D§6,
micro-interaction #15):

```jsx
<span className="inline-flex items-baseline align-baseline leading-[inherit] text-[inherit]
                 tabular-nums [--rolling-number-y-offset:0px]">
  <RollingNumber value={reconnectAttempt} variant="inline"/><span>/{maxAttempts}</span>
</span>
```

Overload branch (`RENDER @ 610921`):
```js
g = r.errorInfo===`serverOverloaded`
 || (typeof r.errorInfo==`object` && `responseStreamDisconnected` in r.errorInfo
     && r.errorInfo.responseStreamDisconnected.httpStatusCode===429)
```

### 3.5 `system-error` row — raw protocol text, no affordance

`RENDER @ 619864`:

```js
function XI({icon, item}){
  if(item.errorInfo===`usageLimitExceeded`) return <ZI icon={icon}/>;
  return <yr layout="verticalIcon" Icon={_i}
             content={<span className="wrap-anywhere">{item.content}</span>}/>;
}
```

`item.content` is `JSON.parse(message).error.message` if the message is a JSON envelope, else the
raw `TurnError.message` verbatim. **No disclosure, no copy button, no truncation** — just
`wrap-anywhere`.

> This is exactly where a string like `thread not found: <uuid>` would land in Codex *if the core
> emitted it as a turn error*. It does not — see §7.

Terminal errors **discard `additionalDetails` entirely** (§6.1) — details survive only on the
transient `stream-error` row. Arguably a Codex bug worth not replicating.

### 3.6 Turn-level terminal states — dividers

All share one shell (`RENDER @ 247078`, `yT`):

```jsx
<Jm>
  <div className={cn(`flex items-center gap-2 text-token-text-secondary`, className)}>
    <div className="flex-1 border-t border-token-border"/>
    <Label className={cn(wrap ? `min-w-0 text-center` : `whitespace-nowrap`, labelClassName)}/>
    <div className="flex-1 border-t border-token-border"/>
  </div>
</Jm>
```

**Interruption folds into "Worked for", it is not a separate row** (`RENDER @ 20884`):

```js
case `working`: `Working for {time}` / `Working`
case `worked`:  `Worked for {time}`          // localConversation.workedFor
case `stopped`: `You stopped after {time}`   // localConversation.userStoppedAfter
```
then, unconditionally for all three: `d = cn('text-token-conversation-body', a)`.

A user-aborted turn and a successful turn use **the identical class string**. The abort is
signalled by the word "stopped" and nothing else.

**Auto-review short-circuit** (`RENDER @ 248640`) — the pattern for a terminal failure *with*
remediation guidance:

```
message  = "Turn ended by Auto-review"
trailing = <Tooltip content="Auto-review stopped this turn after repeated denials. Add more
            context or choose a different permission mode to continue.">
             <InfoIcon className="icon-2xs"/>
           </Tooltip>
```

Divider label + a 12px info glyph carrying a tooltip. The remediation text is **not shown inline**
— it is one hover away.

**Usage limit** routes through `system-error` → `CT` → `yT`, i.e. also a centred divider,
`text-token-text-secondary`, `wrapMessage` → `min-w-0 text-center`. A hard billing wall — the most
terminal state in the product — is a centred grey line between two hairlines.

### 3.7 Motion

Duration tokens (`CSS`): `--transition-duration-basic:.15s`, `--transition-duration-relaxed:.3s`,
default easing `cubic-bezier(.4,0,.2,1)`; `--duration:0s` under `prefers-reduced-motion`.

Error rows enter and exit **exactly like normal rows** — measured-height + opacity via the same
shared transition constant `Ve` used by successful content (`RENDER @ 612400`, `@ 21800`). There is
no bespoke error entrance: no shake, no flash, no attention-grabbing motion of any kind.

The composer-banner wrapper has its own spec (`ANIM @ 11694`, `Le`):

```js
transition = { duration: .22, ease: [.23, 1, .32, 1] }        // 220ms, expo-out
animate    = { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }
exit       = { height: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }
exit (reduced motion) = { opacity: 0, overflow: 'hidden', pointerEvents: 'none' }
```

Under `<AnimatePresence initial={false}>` — **mount does not animate**; the banner appears at
natural height. Only `transitionEnd:{overflow:'visible'}` fires, releasing clipping so popovers can
escape after settling. `pointerEvents:'none'` on exit prevents click-through during the collapse.

> Note: a naive `grep AnimatePresence` returns nothing — the identifier is minified away.
> framer-motion *is* present and *is* used here; only `mfl5y5w0-DN7HHNLo.js` retains the literal
> package string.

---

## 4. Tokens — what exists vs what is used

### 4.1 Base palette (`CSS`)

```
--red-50:#ffd9d9   --red-300:#ff6764   --red-400:#fa423e
--red-500:#e02e2a  --red-600:#ba2623   --red-900:#4d100e
--orange-50:#ffe7d9 --orange-300:#ff8549 --orange-400:#fb6a22
--orange-500:#e25507 --orange-700:#923b0f --orange-900:#4a2206
```

### 4.2 Semantic tokens, both themes

| token | dark (`.electron-dark`) | light (`.electron-light`) | used in transcript? |
|---|---|---|---|
| `--color-text-error` | `#ff6764` | `#e02e2a` | **no** |
| `--color-icon-error` | `#ff6764` | `#e02e2a` | **no** |
| `--color-border-error` | `#fa423e66` (40%) | `#e02e2a26` (15%) | **no** |
| `--color-background-status-error` | `#4d100e` | `#ffd9d9` | **no** |
| `--color-background-danger-active` | `#fa423e5c` (36%) | `#e02e2ae6` (90%) | **no** |
| `--color-text-warning` | `#ff8549` | `#e25507` | **no** |
| `--color-icon-warning` | `#ff8549` | `#e25507` | **no** |
| `--color-border-warning` | `#ff854966` | `#e2550726` | **no** |
| `--color-background-status-warning` | `#4a2206` | `#ffe7d9` | **no** |

VSCode-bridged alias chains:

```
--color-token-error-foreground        → --vscode-errorForeground        → --color-text-error
--color-token-editor-error-foreground → --vscode-editorError-foreground → --color-text-error
--color-token-charts-red              → --vscode-charts-red             → --color-accent-red
--color-token-input-validation-error-background → --color-background-status-error
--color-token-input-validation-error-border     → --color-border-error
```

### 4.3 Usage census

| token | where genuinely used | transcript? |
|---|---|---|
| `token-editor-error-foreground` | worktree-init failed **icon**; settings pages | **icon only, bootstrap rows only** |
| `token-error-foreground` | `THREAD @ 109917` settings dialog; the `tone="error"` recipe | **no** |
| `token-charts-red` | 26 bundles; in `THREAD` only 2× (CI glyph, merge-conflict glyph) | **no — side panel only** |
| `background-status-error` | `tone="error"` recipe, at `/20` opacity | **no** |
| `border-error`, `icon-error`, `text-warning`, `icon-warning`, `background-status-warning` | **UNVERIFIED consumer** — defined in CSS, no JS class-string consumer located | **no** |

### 4.4 The muted ladder actually carrying failure text

| token | chain | dark value |
|---|---|---|
| `--color-token-input-placeholder-foreground` | → `--color-text-foreground-tertiary` | **#ffffff80** (50%) |
| `--color-token-description-foreground` | → `--color-text-foreground-tertiary` | **#ffffff80** (50%) |
| `text-token-description-foreground/80` | 50% × 80% | **≈#ffffff66** (40% effective) |
| `--color-token-conversation-body` | `color-mix(oklab, foreground 60%, transparent)` | **#ffffff99** (60%) |
| `--color-token-text-secondary` | literal | **#ffffffa6** (65%) |
| `--color-token-border` | literal | **#ffffff14** (8%) |
| `--color-token-border-heavy` | `color-mix(oklab, foreground 12%, transparent)` | **≈#ffffff1f** (12%) |

> Drift note: D§6 records `text-secondary` as `#ffffffb3` (70%). This build's CSS states
> `#ffffffa6` (65%). Minor version drift; prefer this build's value.

### 4.5 The `tone="error"` recipe (settings only)

`SHELL @ 12550` — the variant maps for the shared banner shell:

```js
border: { error:`border-token-error-foreground/20 text-token-error-foreground`,
          infoAccent:`border-token-text-link-foreground/40 text-token-foreground`,
          normal:`border-token-input-border text-token-foreground`,
          warning:`border-token-editor-warning-foreground/30 text-token-foreground` }
fill:   { error:`bg-token-input-validation-error-background/20`,
          infoAccent:`bg-token-input-background`,
          normal:`bg-token-input-background`,
          warning:`bg-token-input-validation-warning-background/30` }
container: `relative isolate flex w-full overflow-hidden rounded-2xl border
            bg-token-main-surface-primary py-2 pl-3 pr-2 text-sm shadow-xs lg:mx-auto
            electron:border-0 electron:ring-[0.5px] electron:ring-token-border-heavy`
```

Root element is `<aside aria-live={ariaLive} role={role}>`. Note the Electron divergence:
`electron:border-0 electron:ring-[0.5px]` — a hairline ring replaces the border in the desktop app.

Even at `tone="error"`, the fill is **20% opacity** of an already-dark status colour and the border
is **20% opacity** of the error foreground. This is the loudest error chrome in the product and it
is still a wash, not a fill.

---

## 5. Composer gating

### 5.1 Blocked ≠ disabled

The send button (`BTN @ 36522`, `Zr`):

```js
disabled = isLoading || disabled                 // native attribute
A = !isLoading && !!blockedReason && 'opacity-50'   // blocked: dimmed but CLICKABLE
k = (isLoading || disabled) && 'cursor-default opacity-50'
base = `cursor-interaction size-token-button-composer flex items-center justify-center
        rounded-full transition-opacity focus-visible:outline-2`
     + `bg-token-foreground p-0.5 focus-visible:outline-token-button-background`
tooltipKey = x ? `forced-${nonce}` : 'submit-button-tooltip'
```

At the local-session call site the native `disabled` reduces to
**`submitDisabled = (conversationId == null)`** (`THREAD @ ~289900`) — true only while a worktree
is being created, when the placeholder reads *"Waiting for worktree setup…"*.

**`blockedReason` is not in the `disabled` expression.** A blocked composer stays clickable and
focusable; refusal is explained on intent. Changing the tooltip nonce remounts the tooltip, forcing
it open again — that is how repeat-clicking re-fires the message.

**No `aria-disabled` and no `data-disabled` on the send button.** Native `disabled` only.

### 5.2 The 19-member priority cascade

One ordered cascade (`COMPOSER`, `FV`, terminating `@ 599035`) produces **one reason string**, not
N scattered booleans:

```js
return e?`windows-sandbox-readiness-error`:t===`setup`?`windows-sandbox-required`
 :t===`update`?`windows-sandbox-update-required`:n?`loading-local-config`:r?`missing-workspace`
 :i?`restorable-working-directory`:a?`missing-working-directory`:o?`workspace-status-unavailable`
 :s?`loading-local-config`:c?`remote-disconnected`:l?`remote-login-required`
 :u?`missing-remote-project-path`:d?`missing-cloud-config`:f?`unsupported-image-inputs`
 :p?`image-uploads`:m?`file-uploads`:h?`pasted-text-unavailable`:g?`missing-cloud-turn`
 :_?null:`empty-message`
```

The closed union is independently confirmed by the analytics mapper `$S` (`COMPOSER @ 40324`).

| Reason | Predicate | Means |
|---|---|---|
| `windows-sandbox-readiness-error` | `agentMode!=='read-only' && hasWindowsSandboxRequirementError` | Sandbox health check failed |
| `windows-sandbox-required` | `isWindowsSandboxSetupPending` | Sandbox not installed |
| `windows-sandbox-update-required` | `windowsSandboxRequirement==='update'` | Sandbox stale |
| `loading-local-config` (1st) | `isAgentModePending \|\| (isWindowsSandboxRequirementPending && !setupPending)` | Permission mode resolving |
| `missing-workspace` | `UV(e)` | No project folder |
| `restorable-working-directory` | `materialization==='restorable'` | Worktree pruned, restorable |
| `missing-working-directory` | `materialization==='gone'` | cwd deleted, unrecoverable |
| `workspace-status-unavailable` | `materialization==='unavailable'` | Can't stat the worktree |
| `loading-local-config` (2nd) | `materialization==='loading' \|\| IV(e)` | Workspace roots loading |
| `remote-disconnected` | `isLocalModeOnRemoteHost && state==='disconnected'` | SSH transport down |
| `remote-login-required` | `remoteConnectionError?.code==='login-required'` | **SSH** auth — *not* account auth |
| `missing-remote-project-path` | `isLocalModeOnRemoteHost && currentRemoteCwd==null` | No remote path mapped |
| `missing-cloud-config` | `BV(e)` | No cloud environment chosen |
| `unsupported-image-inputs` | model lacks vision + images attached | Model capability |
| `image-uploads` / `file-uploads` | uploads in flight | Attachment not ready |
| `pasted-text-unavailable` | `Bn(br,Ir,pr)` | Pasted-text blob unavailable |
| `missing-cloud-turn` | `followUp?.type==='cloud' && !selectedTurnId` | Cloud follow-up needs a turn |
| `empty-message` | `!hasMessageContent` | Empty composer |

**Every member is environment-shaped.** No quota, credits, plan, entitlement, model-availability,
or ChatGPT-login gate. Term census across the composer/thread bundles: `isAuthenticated`,
`needsAuth`, `accountStatus`, `loginStatus`, `availableModels`, `modelAvailability`, `entitlement`,
`capabilities` → **0 hits each**.

### 5.3 Two refusal surfaces

`COMPOSER @ 264800`:

```js
if(ce!=null){ …
  if(ce===`empty-message`){ if(S(te))return; z(); return }   // z = forced tooltip
  R(); return                                                 // R = modal dialog
}
```

- `empty-message` → **nonce-forced tooltip** on the button.
- Every other reason → **modal dialog**, titled `composer.submit.blockedDialogTitle` →
  **"Unable to send message"**, body = the reason string, button **"OK"**.

### 5.4 Block-reason copy (`WV`, `COMPOSER @ 600236–604400`)

| Reason | id | defaultMessage |
|---|---|---|
| `windows-sandbox-required` | `composer.submit.windowsSandboxRequired` | **"Set up Agent sandbox to continue"** |
| `windows-sandbox-update-required` | `…windowsSandboxUpdateRequired` | **"Update Agent sandbox to continue"** |
| `windows-sandbox-readiness-error` | `…windowsSandboxReadinessError` | **"Couldn't check Agent sandbox status"** |
| `missing-workspace` | `composer.submit.noWorkspace` | **"Add a project to use ChatGPT"** |
| `restorable-working-directory` | `…restorableWorkingDirectory` | **"Restore the worktree to continue"** |
| `missing-working-directory` | `…missingWorkingDirectory` | **"This chat's working directory no longer exists"** |
| `workspace-status-unavailable` | `…workspaceStatusUnavailable` | **"Couldn't check worktree status"** |
| `loading-local-config` | `…loadingLocalConfig` | **"Loading…"** |
| `remote-disconnected` | `…remoteDisconnected` | **"Remote connection is disconnected"** |
| `remote-login-required` | `…remoteUnauthed` | **"Remote connection needs authentication"** |
| `missing-remote-project-path` | `…missingRemoteProjectPath` | **"Set a remote project path to continue"** |
| `missing-cloud-config` | `…missingCloudConfig` | **"You must choose a cloud environment"** |
| `image-uploads` | `…waitForImageUploads` | **"Images uploading…"** |
| `file-uploads` | `…waitForFileUploads` | **"Files uploading…"** |
| `pasted-text-unavailable` | `…pastedTextUnavailable` | **"Pasted text is unavailable for this target"** |
| `missing-cloud-turn` | `…missingCloudTurn` | **"Cannot follow up on this chat"** |
| `empty-message` | `…emptyMessage` | **"Type a message and click send to get started"** |

Copy pattern worth noting: every actionable reason is phrased as an **imperative with a purpose
clause** — "Set up X *to continue*", "Restore X *to continue*". Non-actionable ones are flat
statements of fact — "Couldn't check worktree status".

### 5.5 The above-composer region — three slots

`COMPOSER @ 707800`:

```jsx
// 1. portal target
<div data-above-composer-portal
     data-above-composer-conversation-id={conversationId}
     className="relative px-[var(--home-composer-inline-inset)] empty:hidden electron:grid" />

// 2. floating (default layout)
<div className="px-[var(--home-composer-inline-inset)] pb-2 empty:hidden">{content}</div>

// 3. header (no wrapper — passed down as aboveComposerHeaderContent)
```

Root: `<div className={cn('min-w-0', className)} data-codex-composer-root>`. All slots use
**`empty:hidden`** — the region self-collapses with zero JS. Portal lookup
(`…dixfr41z-BmPHGtha.js @ 3811`) is scoped per conversation id.

The full local-session stack, top → bottom (`THREAD @ 290860`):

1. `xw`/`dS` — worktree-restore banner
2. `KC` — reconnecting / loading status row
3. `Rc`/`kc` — the composer, hosting the three slots above plus a `banners` prop

### 5.6 The reconnect status row

`THREAD @ 267874`, complete:

```jsx
<div aria-live="polite" role="status"
     className="flex items-center justify-center gap-2 px-4 py-1 text-sm text-token-text-secondary">
  <Spinner className="icon-xs"/>
  {status === 'loading' ? 'Loading chat…' : 'Reconnecting to ChatGPT…'}
</div>
```

- `localConversation.loadingThread` → **"Loading chat…"**
- `localConversation.reconnectingToCodex` → **"Reconnecting to ChatGPT…"**
  (description: *"Status shown above the composer while reconnecting to the Codex app server"*)

`text-token-text-secondary` = **#ffffffa6 (65%)**. A spinner, centred, 65%-opacity text. **No red,
no banner, no border, no background, no animation** — a bare conditional mount. Reconnection is
presented as *loading's sibling*, sharing one component and one class string.

Note the copy says **"ChatGPT"**, not "Codex" — the harness name is hidden from the user.

Trigger (`THREAD @ ~289900`): only computed when `hostId !== 'local'`. **A purely local session
never shows this row.**

### 5.7 Worktree-restore banner — the paired affordance

`THREAD @ 232600`. This is the banner that pairs with the `restorable-working-directory` /
`missing-working-directory` / `workspace-status-unavailable` block reasons — **the state that
blocks Send also renders the fix**:

| State | id | defaultMessage |
|---|---|---|
| unavailable / title | `worktreeRestoreBanner.unavailable.title` | **"Couldn't check worktree status"** |
| unavailable / body | `…unavailable.body` | **"Retry to verify this chat's working directory"** |
| gone / title | `…missing.title` | **"Current working directory missing"** |
| gone / body | `…missing.body` | **"This chat's working directory no longer exists"** |
| restorable / title | `worktreeRestoreBanner.title` | **"Worktree cleaned up"** |
| restorable / body | `worktreeRestoreBanner.body` | **"This chat's worktree was removed to save disk space"** |
| CTA (unavailable) | `…retryCta` | **"Retry"** |
| CTA (restorable) | `…restoreCta` | **"Restore worktree"** |

Rendered `type = unavailable ? 'error' : 'normal'`, `layout="horizontal"`. Inner spans
(`THREAD @ 234500`):

```jsx
<span className="min-w-0 truncate font-semibold text-token-foreground">{title}</span>
<span className="hidden min-w-0 truncate text-token-description-foreground sm:inline">{body}</span>
```

Title bold at full foreground; body muted and **hidden below `sm`**. The banner degrades to a
title + CTA on narrow layouts.

### 5.8 Offline

**There is no offline banner and no `navigator.onLine` handling.** Fixed-string search for
`offline` / `Offline` across `THREAD` and `RENDER`: zero hits. Connectivity loss surfaces only as
the reconnect paths above.

---

## 6. Error classification

### 6.1 The wire vocabulary

`protocol/v2/CodexErrorInfo.ts:12` — the error-code union. Doc comment: *"When an upstream HTTP
status is available … it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo`
variant."*

```ts
export type CodexErrorInfo = "contextWindowExceeded" | "usageLimitExceeded" | "serverOverloaded"
  | "cyberPolicy"
  | { "httpConnectionFailed": { httpStatusCode: number | null } }
  | { "responseStreamConnectionFailed": { httpStatusCode: number | null } }
  | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError"
  | { "responseStreamDisconnected": { httpStatusCode: number | null } }
  | { "responseTooManyFailedAttempts": { httpStatusCode: number | null } }
  | { "activeTurnNotSteerable": { turnKind: NonSteerableTurnKind } }
  | "other";
```

Carriers:

| File:line | Type |
|---|---|
| `TurnError.ts:6` | `{ message: string, codexErrorInfo: CodexErrorInfo \| null, additionalDetails: string \| null }` |
| `ErrorNotification.ts:6` | `{ error: TurnError, willRetry: boolean, threadId: string, turnId: string }` |
| `TurnStatus.ts:5` | `"completed" \| "interrupted" \| "failed" \| "inProgress"` |
| `ThreadStatus.ts:6` | `{type:"notLoaded"} \| {type:"idle"} \| {type:"systemError"} \| {type:"active", activeFlags}` |
| `RateLimitReachedType.ts:5` | `"rate_limit_reached" \| "workspace_owner_credits_depleted" \| "workspace_member_credits_depleted" \| "workspace_owner_usage_limit_reached" \| "workspace_member_usage_limit_reached"` |
| `CommandExecutionStatus.ts:5` / `PatchApplyStatus.ts:5` | `"inProgress" \| "completed" \| "failed" \| "declined"` |
| `CollabAgentStatus.ts` | `"pendingInit" \| "running" \| "interrupted" \| "completed" \| "errored" \| "shutdown" \| "notFound"` |
| `HookRunStatus.ts` | `"running" \| "completed" \| "failed" \| "blocked" \| "stopped"` |

**Failure lives on the turn, not the item.** `ThreadItem.ts` has 16 variants and **none of them is
`error`** — the client *synthesises* an error item from the `error` notification
(`STORE @ 453479`).

### 6.2 `willRetry` is the primary axis, not the error code

The VM builder (`STORE @ 532172`):

```js
case`error`: if(n.willRetry){
    let e=EN(n.message);
    DN(u,{type:`stream-error`, id:n.id,
          content: e==null ? n.message : `Reconnecting ${e.attempt}/${e.maxAttempts}`,
          errorInfo:n.errorInfo, additionalDetails:n.additionalDetails??null, …})
  } else {
    let e=Nj(n); if(e==null) break;
    u.push({type:`system-error`, content:e,
            ...n.errorInfo===`usageLimitExceeded` ? {errorInfo:n.errorInfo} : {}})
  }
  break;
```

Three consequences:
1. `willRetry:true` → transient reconnect row; `false` → terminal system-error row.
2. **`Nj(n)` returning `null` silently DROPS the error item** (`if(e==null)break`).
3. **Terminal errors discard `additionalDetails`** — only `content` carries onto `system-error`.

### 6.3 Master table — `CodexErrorInfo` → what the user sees

| `codexErrorInfo` | Classified? | Shown | Action |
|---|---|---|---|
| `usageLimitExceeded` | **Yes**, dedicated component | 10 plan-dependent variants (§6.4) | CTA in composer banner; none on the row |
| `serverOverloaded` | **Yes**, only when `willRetry` | "Server is busy, reconnecting {n/m}" | none (auto) |
| `responseStreamDisconnected` w/ `httpStatusCode===429` | **Yes**, aliased to serverOverloaded | same | none (auto) |
| `cyberPolicy` | **Yes** — row *suppressed* | composer banner (§6.6) | Learn more / Continue with Terra / Dismiss |
| *(bio, by message prefix or `error.code==='bio_policy'`)* | **Yes** — row *suppressed* | same banner, `domain:'bio'` | same |
| `contextWindowExceeded` | **No** | raw `message` | none |
| `unauthorized` | **No** | raw `message` | none |
| `badRequest` | **No** | raw `message` | none |
| `internalServerError` | **No** | raw `message` | none |
| `threadRollbackFailed` | **No** | raw `message` | none |
| `sandboxError` | **No** | raw `message` | none |
| `httpConnectionFailed` | **No** | raw `message` | none |
| `responseStreamConnectionFailed` | **No** | raw `message` | none |
| `responseStreamDisconnected` (non-429) | **No** | raw `message`, or reconnect row | none |
| `responseTooManyFailedAttempts` | **No** | raw `message` | none |
| `activeTurnNotSteerable` | **No** | raw `message` | none |
| `other` / `null` | **No** | raw `message` (JSON-unwrapped) | none |

Verification method for the "No" rows: `grep -lF '<code>' *.js` over all non-locale bundles →
**zero hits each**.

> **11 of 15 codes have no UI treatment whatsoever.** This is the single most important structural
> finding about Codex's error handling: it ships a rich code vocabulary on the wire and consumes
> almost none of it in the client. **Do not treat Codex's raw-text rendering as an endorsement** —
> it is an unbuilt path, not a designed one. The designed path is `usageLimitExceeded`.

### 6.4 `usageLimitExceeded` — the one fully-built error kind

Variant selector (`RENDER`, `JI`):

```js
function JI({plan, isWorkspaceAccount, isWorkspaceOwner, canFreeOrGoUserPurchaseCodexCredits=false}){
  if(isWorkspaceAccount) return isWorkspaceOwner ? `manage-workspace` : `contact-workspace-owner`;
  switch(plan){
    case FREE: case GO:      return canFreeOrGoUserPurchaseCodexCredits ? `upgrade-or-add-credits` : `upgrade`;
    case PLUS: case PROLITE: return `upgrade-or-add-credits`;
    case PRO:                return `add-credits`;
    default:                 return `retry`;
  }
}
```

Transcript-row copy (all ids `localConversation.usageLimit.*`, descriptions read *"Inline transcript
message"*):

| Variant | reset known | Copy |
|---|---|---|
| `manage-workspace` | — | "You've hit your usage limit. Review your workspace's usage settings to continue." |
| `contact-workspace-owner` | — | "You've hit your usage limit. Contact your workspace owner for more access." |
| `upgrade` | yes | "You've hit your usage limit. Upgrade your plan to continue, or try again at {resetDate}." |
| `upgrade` | no | "You've hit your usage limit. Upgrade your plan to continue, or try again later." |
| `upgrade-or-add-credits` | yes | "You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at {resetDate}." |
| `upgrade-or-add-credits` | no | "…or try again later." |
| `add-credits` | yes | "You've hit your usage limit. Add credits to continue, or try again at {resetDate}." |
| `add-credits` | no | "…or try again later." |
| `retry` | yes | "You've hit your usage limit. Try again at {resetDate}." |
| `retry` | no | "You've hit your usage limit. Try again later." |

**There is no button on the row** — the CTA is embedded as prose. The buttons live in the composer
banner (a much larger per-plan copy family; ~50 strings, not reproduced here).

Reactive discovery (`STORE @ ~682000`):
```js
t.addNotificationCallback(`error`, t =>
  t.params.error.codexErrorInfo===`usageLimitExceeded`
  && e.query.invalidate(xJ).then(()=>e.query.fetch(xJ)).catch(()=>void 0))
// xJ: queryKey:['rate-limit-status'], queryFn: safeGet('/wham/usage'),
//     retry:false, 401/403/404 → null (fail-open)
```

### 6.5 App-server / remote-host connection errors (`CONN`)

The second real classification table. Codes:
`remote-codex-not-found | login-required | restart-required | update-required | connection-failed`.

| code | Badge | Message | Action |
|---|---|---|---|
| `login-required` | "Login required" | "You are currently logged out." | `canLogin` → **"Sign in to Codex"**; badge surface → **"See Settings to connect"**; else none |
| `remote-codex-not-found` | "Codex CLI not installed" | "Codex CLI is not installed on this remote machine" | **"Install Codex CLI"** / "Installing…" |
| `restart-required` | "Restart required" | w/ versions: "Restart now to update to {installedVersion}. Currently running {currentVersion}"; else "Something went wrong connecting to the Codex CLI. Try restarting" | **"Restart now"** (+ tooltip "Restarting will stop the running Codex CLI process and any ongoing tasks on this remote host") |
| `update-required` | "Update required" | "Codex CLI on this environment is out of date. Update to {minVersion} or newer. Current version: {currentVersion}" | connections-row → **"Update Codex CLI"**; WSL → **none** (copy swaps to manual instructions); else "See Settings to connect" |
| `connection-failed` | "Error" | **`return t.message`** — raw server string | **none** |

Non-error states: `Connecting` / `Restarting` / `Connected` / `Disconnected` / `Error`.

### 6.6 Safety-policy blocks — the only transcript→composer hoist

`STORE @ 499519` / `@ 147521`:

```js
function Nj(e){ if(e.willRetry || fm({codexErrorInfo:e.errorInfo, message:e.message})!=null) return null; … }
function fm({codexErrorInfo, message}){
  if(codexErrorInfo===`cyberPolicy`) return `cyber`;
  let n=um(message, mm);
  return n?.success && n.data.error.code===`bio_policy`
      || pm.some(e=>(n?.success?n.data.error.message:message).startsWith(e)) ? `bio` : null;
}
pm = ["Invalid prompt: we've limited access to this content for safety reasons.",
      "This content was flagged for possible biological risk."]
```

`Nj` returns `null` → the VM arm `break`s → **no transcript row at all**. The state is re-derived by
a reverse-scanning jotai selector and rendered as a composer banner:

| id | defaultMessage |
|---|---|
| `codex.safetyComposerBanner.title` | **"This content can't be shown"** |
| `.bio.body` | "We take extra caution with requests involving biological research and applications that could pose safety risks. Eligible researchers can apply for ⟨link⟩Trusted Access⟨/link⟩." |
| `.cyber.body` | "We take extra caution with cybersecurity requests. If you're a security professional, you may be able to apply for ⟨link⟩Trusted Access⟨/link⟩." |
| `.dismissLabel` | **"Dismiss safety banner"** |
| `codex.cyberSafetyComposerBanner.firstBlock.title` | **"This chat was flagged for possible cybersecurity risk"** |
| `…firstBlock.body` | "If this seems wrong, try rephrasing your request or submit /feedback. To get authorized for security work, join the ⟨link⟩Trusted Access for Cyber⟨/link⟩ program." |
| `…repeatedBlocks.title` | **"Your conversations have multiple flags for possible cybersecurity risk"** |
| `…repeatedBlocksTerra.body` | "Responses may take longer than usual because extra safety checks are on. Change to GPT-5.6 Terra to get faster responses now, or join the ⟨link⟩Trusted Access for Cyber⟨/link⟩ program." |

Actions: **"Learn more"** (→ `chatgpt.com/cyber`), **"Continue with GPT-5.6 Terra"** (→
`setModelAndReasoningEffortForNextTurn('gpt-5.6-terra', …)`), **"Dismiss"** (records dismissal keyed
by `{variant, domain, turnId}`).

### 6.7 Retry policy — server-driven, parsed out of prose

**There is no client-side retry loop, no backoff, no max-attempt constant, and no retryable-code
set in the webview.** The core owns retry; the client is told via `willRetry:boolean` and infers
progress by regex over the human-readable message (`STORE`):

```js
YN = /^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/
function EN(e){ let t=YN.exec(e.trim()); return t==null?null:{attempt:+t[1], maxAttempts:+t[2]} }
```

Consecutive reconnect rows coalesce rather than stack (`DN`): if the last item is a `stream-error`
with a non-null `reconnectAttempt`, it is **replaced** in place, preserving the original id.

**Retryable ⇔ `willRetry===true`**, full stop.

---

## 7. Thread loss and recovery — the answer to the brief's open question

The brief asks what Codex does with a failure that is *nominally* pre-send-knowable (the process
was already dead) but only *discovered* at turn time. **Codex treats a lost thread as a routing
event, not an error.** Four mechanisms:

**(a) Lazy resume — `needs_resume` is the default state, not an error state.**
Every conversation is constructed with `resumeState:'needs_resume'` (`STORE @ 134865`, `@ 300899`,
`@ 324375`, `@ 366079`). Only three values exist: `needs_resume → resuming → resumed`.

**(b) A resume failure silently reverts and rethrows — no transcript item, no toast** (`STORE @ 376119`):

```js
} catch(n){
  throw w && e.releaseResumeNotificationBuffer(t),
  e.updateConversationState(t, e=>{ e.resumeState===`resuming` && (e.resumeState=`needs_resume`) }), n
}
```

The subagent path adds a log line — and note where the raw error goes:

```js
W.warning(`Failed to resume subagent for file approval`,
          {safe:{conversationId:t}, sensitive:{error:n}})
```

`sensitive:{error:n}` — **the raw error goes to the log channel, never to the UI.** This
safe/sensitive split appears ~15× in `STORE`.

**(c) A thread that truly vanished ⇒ silent redirect home** (`PAGE`, `Bu`):

```js
if (hadConversation && !hasConversation) { … return <Bu project={g}/> }

function Bu({project}){
  let o = () => { _e(i,`work`),
    a(`/`, {replace:true, state:{focusComposerNonce:Date.now(), ...project===undefined?{}:{project:ir(project)}}}) }
  useEffect(o, s); return null
}
```

Route-replace to `/`, composer focused, project context preserved. **Zero error UI.**

**(d) The only visible trace is the neutral status line** of §5.6 — *"Reconnecting to ChatGPT…"*.

The literal token `notFound` reaches a user in exactly one place, and it is lowercase prose in a
*subagent status chip*, not an error: `localConversation.multiAgentAction.agentState.notFound` →
**"not found"**, rendered alongside siblings `pending init` / `running` / `interrupted` /
`shutdown` / `completed` / `errored`.

> **Direct answer for Claxedo**: the Codex-equivalent behaviour for `thread not found: <uuid>` is
> **resume lazily; on repeat failure, redirect home with project context preserved and the composer
> focused; show nothing**. The only acceptable visible artifact is a neutral reconnect line above
> the composer.

---

## 8. What happens to a user message whose turn failed

**It stays in the transcript, verbatim, permanently. Not marked failed, not un-sent, not
auto-retried, not removed. There is no optimistic-insert rollback.** The only signal is the sibling
error row.

**Optimistic insert** (`STORE @ 402664`): `{turnId:null, status:'inProgress', …}`, identified by
`params.clientUserMessageId` until the server answers.

**Submit failure — mark, never roll back** (`STORE @ 403695`):

```js
catch(n){ …
  let t=lD(e,c,null);
  if(t){ let n=`Error submitting message`;
    t.items ||= [], t.items.push({type:`error`, id:J(), message:n, willRetry:false,
                                  errorInfo:null, additionalDetails:null}),
    t.status=`failed`,
    t.error={message:n, codexErrorInfo:null, additionalDetails:null} }
  … throw n }
```

The optimistic turn is **kept**; only `status` flips and an `error` item appends. Only
`currentPermissions` rolls back.

> **`"Error submitting message"` is a bare string — no intl id, no `defaultMessage`.** It is not
> localized and reaches the user verbatim as the `system-error` body. A rough edge, not a pattern.

**The status-mapping surprise** (`…g8980z4e-vQo9Ehg-.js @ 89238`) — verbatim, complete:

```js
function Of(e){switch(e){
  case`completed`:  return`complete`;
  case`interrupted`:return`cancelled`;
  case`failed`:     return`complete`;
  case`inProgress`: return`in_progress`}}
```

**`failed` → `complete`.** The view-model turn status is a 3-value enum
`"in_progress" | "complete" | "cancelled"` — **there is no `failed` VM state.** A failed turn is
visually identical to a successful one except for the error row.

**The only un-sent state** is hook-blocked: `deliveryStatus:'not-sent'`, set when a
`userPromptSubmit` hook run has `status==='blocked'`. Rendered as a status link below the bubble:
`codex.userMessage.hookBlocked` → **"Hook blocked this message"** (*"Status link shown below a user
message that was blocked before it entered the conversation"*). Even here the message stays.

**Steer/queued messages are the one real eviction + retry path.** Status enum
`pending → accepted`; unaccepted steers are evicted on `turn/completed` with a `pausedReason`:

```js
Bh = `Interrupted before the steer was accepted.`   // → isPaused
Vh = `Run ended before the steer was accepted.`     // → isFailed
```

Queue copy:

| id | defaultMessage |
|---|---|
| `composer.queuedMessage.interruptedQueue` | **"Queue paused because you interrupted"** |
| `.resumeInterruptedQueue` | **"Resume"** |
| `.pausedTooltip` | **"This queued message could not be sent"** |
| `.pausedTooltipRemedy` | **"Retry, edit, or delete it to continue the queue"** |
| — | "Try sending this queued message again" / "Edit or delete it if retry keeps failing" |

**Turn-failed → "could not be sent" + Retry / Edit / Delete. Interrupted → "Queue paused because
you interrupted" + Resume. Retry is always manual.**

**Edit-to-recover is destructive**: editing the last message issues
`thread/rollback {threadId, numTurns:1}`. Guarded by *"Only the most recent message can be edited."*
and *"Cannot edit a message while a turn is in progress."* A `failed` turn is not `inProgress`, so
editing is permitted. The edit affordance has **no failure-conditional branch** — it is identical
on failed and successful turns.

---

## 9. Recovery-action inventory

| Label | Dispatches | Attached to |
|---|---|---|
| **Try again** | `window.location.reload()` | webview error boundary |
| **Try again** | `resetError()` | per-turn render failure |
| **Sign in to Codex** | `{kind:'login'}` | `login-required` (only when `canLogin`) |
| **See Settings to connect** | `navigate('/settings/connections')` | `login-required` (badge), `update-required` (default) |
| **Open connection settings** | `navigate('/settings/connections')` | remote connection removed |
| **Install Codex CLI** / Installing… | `{kind:'install-codex'}` | `remote-codex-not-found` |
| **Update Codex CLI** / Updating… | `{kind:'install-codex'}` | `update-required` (connections-row) |
| **Restart now** | `{kind:'restart'}` | `restart-required` |
| **Reconnect** | `mcpServer/oauth/login` → open URL → `config/mcpServer/reload` | MCP auth expired |
| **Restore worktree** / **Retry** | worktree restore | worktree-restore banner |
| **Start new side chat** | recreate side chat | side chat expired |
| **Retry** / **Resume** | resend / resume queue | queued message |
| **Go back** | `navigate(-1)` | pending projectless thread failed |
| **Learn more** | open `chatgpt.com/cyber` | cyber banner |
| **Continue with GPT-5.6 Terra** | `setModelAndReasoningEffortForNextTurn` | cyber banner, repeated blocks |
| **Open in web** | open `${host}/tasks/${id}` | **cloud** turn failed |
| **OK** | close | submit-blocked dialog |
| *(none)* | — | **every `system-error` row, all 11 unhandled codes, `connection-failed`, WSL `update-required`** |

**A failed local turn has no Retry button.** There is no `retryTurn` / `regenerate` /
`resendMessage` id anywhere in the ~9790-key locale index. Recovery from a failed turn = type
another message, or edit the last one (destructive rollback).

**There is no "Copy error details", no "Report error", and no "View logs" on any error surface.**
The only reporting paths are the user-initiated `/feedback` dialog (with opt-in
`includeLogsLabel` / `correlationIdLabel`) and a content-safety report dialog — neither is attached
to an error.

The one bulk-export path that carries raw text is copy-conversation-as-markdown
(`conversation-markdown-DDddOfbI.js @ 5564`):

```js
case`system-error`: return N(`System error`, e.content);
case`stream-error`: return P(`Stream error`, [e.content, e.additionalDetails]);
```

---

## 10. Placement decision tree

Legend: **[V]** verified from code · **[I]** inferred.

```
FAILURE
│
├─ Tool call returns non-zero / errors  ......................  TRANSCRIPT ROW, unchanged  [V]
│    • verb stays "Ran {command}" — no failure wording
│    • no icon tint, no colour, no chrome
│    • outcome visible ONLY in expanded footer "Exit code {n}"
│
├─ Command stopped / interrupted by user  ....................  TRANSCRIPT ROW  [V]
│    • "Stopped {command}"; expanded footer "Stopped"
│
├─ Approval denied / patch rejected  .........................  TRANSCRIPT ROW  [V]
│    • "Denied request" — structural peer of "Approved request", identical styling
│
├─ Worktree / env / session bootstrap failed  ................  TRANSCRIPT ROW + ICON TINT  [V]
│    • the ONLY verified icon tint; label stays muted
│
├─ Subagent errored  .........................................  CHIP / ROW, plain word  [V]
│    • "errored" is a peer of "completed"; chip suffix collapses to "interrupted"
│
├─ SSE drop / disconnect / HTTP 429  .........................  TRANSCRIPT ROW (standalone)  [V]
│    • "Reconnecting 1/5" w/ rolling number; expandable raw detail
│
├─ Server 5xx / unclassified system error  ...................  TRANSCRIPT ROW (standalone)  [V]
│    • raw TurnError.message, no affordance; lifted out of the fold if turn produced nothing
│
├─ Reconnecting to the app server  ...........................  COMPOSER-ADJACENT status  [V]
│    • spinner + "Reconnecting to ChatGPT…", 65% text, shares component with "Loading chat…"
│
├─ Turn aborted by user  .....................................  TURN-FOLD DIVIDER  [V]
│    • "You stopped after {time}" — identical class to "Worked for {time}"
│
├─ Turn ended by auto-review  ................................  SYNTHETIC DIVIDER  [V]
│    • label + icon-2xs info tooltip carrying the remediation
│
├─ Usage limit exceeded  .....................................  DIVIDER **and** COMPOSER BANNER  [V]
│    • row = what happened (text only) · banner = what to do (CTAs)
│
├─ Bio / cyber policy block  .................................  COMPOSER BANNER only  [V]
│    • transcript row SUPPRESSED (Nj → null)
│
├─ Workspace / sandbox / SSH not ready  ......................  COMPOSER BANNER + BLOCK SEND  [V]
│    • banner renders the fix; Send explains refusal via modal on click
│
├─ Turn render crash  ........................................  TRANSCRIPT CARD, neutral  [V]
│    • border-token-border (8% white), "This turn couldn't render" + "Try again"
│
├─ Settings / dropdown / dialog load failure  ................  tone="error", off-transcript  [V]
│    • the ONLY place real error colour is chrome — and it is a 20% wash
│
├─ Git / PR status unavailable  ..............................  SIDE PANEL, tone="muted"  [V]
│    • red GLYPH on an explicitly muted row
│
├─ Thread lost / not found  ..................................  NOWHERE — ROUTING EVENT  [V]
│    • lazy resume; on hard loss, navigate('/') w/ project preserved + composer focused
│
└─ Network offline  ..........................................  NOWHERE  [V — absence]
```

---

## 11. The rules distilled

1. **Failure is a word, not a colour.** The verb changes; nothing else does.
2. **Failure is never louder than success.** Success gets the checkmark; failure gets nothing.
3. **`tone="muted"` is the declared tone for errors** — Codex says so literally.
4. **Colour is a glyph budget, never a chrome budget.** No coloured rail exists anywhere in the
   product; the tinted-banner hook exists and has zero callers.
5. **Terminal states are dividers** — the same shell as "Worked for 1h 22m 5s".
6. **Placement follows actionability, not timing.** A concrete next step earns a composer-adjacent
   banner with a CTA; no next step earns a quiet transcript row.
7. **The state that blocks Send also renders the fix.** Worktree-restore is the model: one banner
   carries the diagnosis and the button, and the same condition drives the block reason.
8. **Blocked ≠ disabled.** The button stays clickable and explains the refusal on intent, keyed by
   a nonce so repeat clicks re-fire it.
9. **Block reasons are one priority-ordered cascade producing one string** — not N booleans
   scattered across the tree.
10. **A lost session is a routing event.** Resume lazily, redirect on hard loss, preserve context,
    say nothing.
11. **Raw protocol text is a debug escape hatch, never a headline** — and only on the *transient*
    row, revealed by a hover-gated chevron.
12. **Motion never distinguishes failure.** Shared transition, measured height + opacity. Nothing
    flashes or shakes.

---

## 12. Stated gaps — **UNVERIFIED**

1. **`Ve` transition object value** (the shared row transition) — cross-module minified import, not
   resolvable from class strings. D§6's app-wide `.15s`/`.3s` measured-height spec is consistent
   with observed behaviour.
2. **`yr` component class strings** (the `system-error` `layout="verticalIcon"` shell) — defined in
   an unresolved module.
3. **Model unavailable / no model selected / model deprecated** — searched the ~9790-key locale
   index for `modelUnavailable|modelDeprecated|deprecated|noModelSelected`; only
   `composer.modelSettings.errorGeneric` and `…errorConfigValidation` exist, English text not
   extracted. Codex may simply have no model-availability error copy.
4. **Model refusal / context overflow as transcript items** — no item type found. `contextWindowExceeded`
   exists on the wire with zero consumers; compaction is a *normal-operation* marker, not a failure.
   A refusal presumably arrives as ordinary assistant prose.
5. **Live error payloads** — grepped all `~/.codex/sessions/**/*.jsonl` for `"type":"error"`: zero
   matches. No recorded shapes to corroborate `TurnError` against.
6. **`ThreadStatus {type:"systemError"}`** is declared in the protocol; no consumer branch found
   (all `systemError` hits are the unrelated client-side `system-error` *item* type).
7. **`--color-border-error`, `--color-icon-error`, `--color-text-warning`, `--color-icon-warning`,
   `--color-background-status-warning`** — defined in CSS, no JS consumer located. Dead or near-dead.
8. **Animation of the quota and safety banners** — placement and copy verified; whether they route
   through the same `Le`/`AnimatePresence` wrapper as the safety-buffering banner was not confirmed.
9. **Editability of a submit-time failure** (`turnId:null`) — the `l?.turnId!==n.turnId` guard
   suggests `null !== undefined` would throw *"Only the most recent message can be edited."*,
   stranding the message. The helper's body could not be located. **Do not treat the stranding as
   established.**
10. **Whether stderr is separated from stdout at the producer** — the component contract takes a
    single `output` string, so no separation exists in the UI; the producer side is outside the
    webview bundle.
