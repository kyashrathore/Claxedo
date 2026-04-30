# Rebase Agent Documentation

## Purpose

The Rebase Agent is responsible for bringing useful upstream changes into this fork without damaging fork-specific behavior. Sometimes that means a full rebase of `dev` onto `upstream/dev`. Sometimes it means a smaller targeted carryover. The job is not "make us look like upstream". The job is "keep intentional fork drift, while reliably absorbing upstream value".

For day-to-day execution order, required validation gates, and documentation checklist, use `.dev-docs/DAILY_UPSTREAM_SYNC_PLAYBOOK.md` as the operational runbook.

## Goals

1. **Keep intentional fork drift intact**
2. **Bring in upstream bug fixes, refactors, and useful patterns quickly**
3. **Catch silent breakage that review/rebase alone will not catch**
4. **Keep the process fast and repeatable without over-constraining judgment**
5. **Document only the decisions that future syncs need**

## Working Principle

Use enough structure to avoid missing important upstream changes, but not so much structure that the agent anchors on a script instead of thinking.

### What must be explicit

- What upstream commit or time range is being reviewed
- Which fork-owned files or override pairs are in scope
- For high-risk upstream changes: `ported`, `skipped`, or `deferred`
- What validation was run, and what still needs confidence

### What should stay judgment-based

- Whether this should be a full rebase or a targeted carryover
- Which upstream refactors are worth porting vs. intentionally ignoring
- Which extra tests or smoke checks matter for the touched surfaces
- Whether a divergence should remain local, move into the registry, or be deleted

---

## Repository Configuration

### Remote Setup

```
upstream  https://github.com/anomalyco/opencode.git  (the main OpenCode repo)
origin    https://github.com/kyashrathore/Claxedo.git  (our fork in this checkout)
```

### Branch Strategy

| Branch | Purpose | Source |
|--------|---------|--------|
| `upstream/dev` | Upstream development branch | anomalyco/opencode |
| `origin/dev` (local: `dev`) | Our development branch | kyashrathore/opencode |
| `sync/YYYY-MM-DD` | Daily sync branches | Created by agent |

---

## Pre-Rebase Checklist

Before starting a rebase, the agent must:

1. **Choose the smallest useful sync mode**
   - Use a **targeted carryover** if the goal is to port a specific upstream fix, refactor, or pattern
   - Use a **full rebase** when the fork branch itself should move to current `upstream/dev`
   - Prefer smaller, more frequent syncs over large catch-up rebases

2. **Identify the previous upstream baseline**
   - Read the latest relevant entry in `.dev-docs/SYNC_LOG.md` or `packages/claxedo-app/.dev-docs/CLAXEDO_UPSTREAM_SYNC.md`
   - Record the previous upstream SHA before doing anything else

3. **Check existing sync branches**
   ```bash
   git branch -r | grep sync/
   ```
   - If unmerged sync branches exist, investigate or clean up first

4. **Verify remotes are accessible**
   ```bash
   git fetch upstream --dry-run 2>&1 | head -5
   git fetch origin --dry-run 2>&1 | head -5
   ```

5. **Check for WIP commits on dev**
   ```bash
   git log dev --not upstream/dev --oneline | head -20
   ```
   - Document any commits that will be replayed

6. **Review recent upstream changes**
   ```bash
   git log upstream/dev --since="24 hours ago" --oneline
   ```
   - Identify high-risk areas (extension points, overrides, session/layout/prompt/terminal, shared types, package manifests)

7. **Build a short carryover list before editing**
   ```bash
   git diff <previous-upstream-commit>..upstream/dev --name-only -- packages/app/src/ packages/ui/src/ packages/opencode/src/
   ```
   - Do not try to classify every file
   - Do explicitly note the upstream files that are:
     - override pairs
     - APIs our fork depends on
     - new providers or utilities we may want
     - deleted or moved files that may orphan an override

---

## The Rebase Process

### Step 1: Setup Sync Branch

```bash
# Ensure we're on latest dev
git checkout dev
git pull origin dev

# Create sync branch with timestamp
git checkout -b sync/$(date +%Y-%m-%d)

# Fetch latest upstream
git fetch upstream
```

### Step 2: Attempt Rebase

```bash
# Start rebase onto upstream/dev
git rebase upstream/dev
```

### Step 3: Handle Outcomes

#### Case A: Clean Rebase (No Conflicts)

**Do NOT skip to validation.** Proceed to the **Upstream Drift Review** section below — clean rebases can still introduce silent breakage.

#### Case B: Merge Conflicts Detected

**STOP and analyze using the Decision Tree below.**

After all conflicts are resolved and `git rebase --continue` finishes, proceed to the **Upstream Drift Review** section.

---

## Conflict Resolution Decision Tree

### Decision Tree for AI Agents

```
CONFLICT DETECTED in file X
│
├─ 1. Is X in packages/claxedo-app/?
│   └─ YES → Keep OUR changes (this is our code)
│       Action: git checkout --ours X && git add X
│
├─ 2. Is X in packages/app-shared/?
│   └─ YES → Keep OUR changes (extension system is ours)
│       Action: git checkout --ours X && git add X
│
├─ 3. Is X listed in "Upstream Modifications Registry"?
│   └─ YES → Follow the specific "Merge Strategy"
│       ├─ "Accept upstream" → git checkout --theirs X && git add X
│       ├─ "Keep ours" → git checkout --ours X && git add X
│       ├─ "Merge carefully" → Manual 3-way merge required
│       └─ Check CLAXEDO_UPSTREAM_SYNC.md for patterns
│
├─ 4. Is X a package.json?
│   └─ YES → Merge dependencies manually
│       - Keep our added dependencies
│       - Accept upstream version bumps
│       - Resolve version conflicts conservatively (use higher version)
│
├─ 5. Is X a lockfile (bun.lock, package-lock.json, etc.)?
│   └─ YES → Regenerate after package.json merge
│       Action: Accept theirs, then run 'bun install' after rebase
│
├─ 6. Is X in the "Never Modify" list?
│   └─ YES → Accept upstream entirely
│       Action: git checkout --theirs X && git add X
│       Note: If we modified it, document the deviation
│
└─ 7. DEFAULT: Accept upstream entirely
    └─ We shouldn't have modified files not in registry
    Action: git checkout --theirs X && git add X
    Note: Document this as potential new modification
```

### File Location Reference

| Path | Category | Resolution |
|------|----------|------------|
| `packages/claxedo-app/**` | Our Code | Keep ours |
| `packages/app-shared/**` | Extension System | Keep ours |
| `packages/app/**` | Upstream | Check Registry |
| `packages/opencode/**` | Upstream | Check Registry |
| `packages/desktop/**` | Upstream | Check Registry |
| `packages/ui/**` | Upstream | Accept theirs |
| `packages/sdk/**` | Upstream | Accept theirs |
| `claxedo/**` | Our Backend | Keep ours |
| `*.lock` | Generated | Regenerate |
| `package.json` | Config | Manual merge |

---

## Specific Conflict Patterns

### Pattern 1: Extension Hook Integration

**Context:** Upstream modified a file where we added extension hooks.

**Resolution Strategy:**
```typescript
// CONFLICT: Both upstream and we modified app.tsx

// STEP 1: Accept upstream changes first
git checkout --theirs packages/app/src/app.tsx

// STEP 2: Re-apply our extension integration
// Look for patterns like:
const extensions = getExtensions()
const wrapProviders = (providers, children) => 
  providers.reduceRight((acc, P) => <P>{acc}</P>, children)

// STEP 3: Add our hooks back in appropriate places
// (use git show HEAD:packages/app/src/app.tsx to see our version)
```

### Pattern 2: Export Additions

**Context:** Upstream added new exports, we also added exports.

**Resolution Strategy:**
```typescript
// CONFLICT in packages/app/src/index.ts

// STEP 1: Accept all upstream exports
git checkout --theirs packages/app/src/index.ts

// STEP 2: Add our additional exports at the end
export { useTerminal, TerminalProvider } from "./context/terminal"
export { ClaxedoThing } from "./claxedo-specific"  // if any
```

### Pattern 3: Context Provider Modifications

**Context:** Upstream modified a context we override.

**Resolution Strategy:**
```typescript
// CONFLICT in packages/app/src/context/terminal.tsx

// STEP 1: Note the upstream changes
// STEP 2: Apply those changes to OUR override in packages/claxedo-app/src/overrides/context/terminal.tsx
// STEP 3: Accept upstream version for the original file
git checkout --theirs packages/app/src/context/terminal.tsx

// STEP 4: Update our override to incorporate upstream changes
// (Check git show upstream/dev:packages/app/src/context/terminal.tsx)
```

### Pattern 4: Extension Point Additions

**Context:** Upstream added new functionality that should be exposed as extension points.

**Resolution Strategy:**
1. Accept upstream changes
2. Add extension point to `packages/app-shared/src/extension-points.ts`
3. Wire extension point into upstream file
4. Document in CLAXEDO_UPSTREAM_SYNC.md

---

## Manual 3-Way Merge Process

When "Merge carefully" is required:

### Step 1: Understand Both Versions

```bash
# See our version
git show HEAD:packages/app/src/app.tsx > /tmp/ours.tsx

# See upstream version
git show upstream/dev:packages/app/src/app.tsx > /tmp/theirs.tsx

# See common ancestor
git show $(git merge-base HEAD upstream/dev):packages/app/src/app.tsx > /tmp/base.tsx

# Compare
diff -u /tmp/base.tsx /tmp/theirs.tsx  # What upstream changed
diff -u /tmp/base.tsx /tmp/ours.tsx    # What we changed
```

### Step 2: Identify Overlapping Changes

- If upstream refactored a function we modified → **ESCALATE**
- If upstream added code near our hooks → **Merge carefully**
- If changes are in different sections → **Apply both**

### Step 3: Resolve and Mark

```bash
# After manual editing
git add packages/app/src/app.tsx
git rebase --continue
```

---

## Upstream Drift Review (Critical)

**After the rebase completes but BEFORE validation**, review upstream changes to catch silent breakage that doesn't produce merge conflicts. Conflicts only surface when both sides modify the same lines. In this fork, that is not enough: we also need to actively harvest good upstream changes from areas where we intentionally diverge.

### Why This Step Exists

Real examples from past rebases:
- Upstream extracted inline components from `layout.tsx` into `./layout/*.tsx` files. Our modified `layout.tsx` kept the inline versions but was missing the new imports (`Switch`, `Match`, `Spinner`, `HoverCard`, `Collapsible`, `MessageNav`) that upstream's extracted files import separately — **no conflict**, just broken code.
- Upstream added `focusInput` to a function signature in `session.tsx`. Our override calls that function but didn't pass the new param — **no conflict**, just a type error.
- Upstream changed `LocalPTY` from an exported type to a local one, then re-exported it differently. Our override imported it but didn't re-export — **no conflict**, downstream code broke silently.
- Upstream added `@tauri-apps/plugin-clipboard-manager` to `desktop/package.json`. Our commit modified the same `package.json` for other reasons but the dep wasn't in our version — **no conflict** because different lines.
- Upstream added `flushResize()` to an interface. Our code implements that interface in a different file — **no conflict**, just a missing method.

### What To Review

Keep this review lightweight but explicit. The goal is not an exhaustive audit of every upstream file. The goal is to make sure the risky and high-value changes get an intentional decision.

For the files that matter, leave a compact note in the sync log using this shape:

```markdown
| Area | Decision | Notes |
|------|----------|-------|
| `packages/app/src/context/terminal.tsx` | Ported | Took upstream cleanup fix, kept server-scoped persist |
| `packages/app/src/pages/session.tsx` | Skipped | New sidebar behavior conflicts with split view |
| `packages/app/src/utils/format-duration.ts` | Deferred | Useful, but not needed for this sync |
```

If a changed upstream file is in a high-risk area and it is neither ported nor consciously skipped, the review is incomplete.

#### 1. Diff upstream changes against files we override or modify

```bash
# List files changed in upstream since last sync
git diff <previous-upstream-commit>..upstream/dev --name-only

# Cross-reference with our overrides
ls packages/claxedo-app/src/overrides/

# For each upstream file that has a corresponding override, review what changed:
git diff <previous-upstream-commit>..upstream/dev -- packages/app/src/context/terminal.tsx
git diff <previous-upstream-commit>..upstream/dev -- packages/app/src/pages/session.tsx
# ... etc.
```

**Key question:** Did upstream change any API surface (exports, function signatures, interfaces, types) that our overrides or extension code depends on?

#### 2. Check for new/removed exports in upstream modules we import from

```bash
# Find all upstream modules our code imports
grep -rh "from ['\"]@/" packages/claxedo-app/src/ | sort -u

# For each critical module, compare exports
git show <previous-upstream-commit>:packages/app/src/context/terminal.tsx | grep "^export"
git show upstream/dev:packages/app/src/context/terminal.tsx | grep "^export"
```

**Key question:** Did any type/function we import get renamed, removed, or have its signature changed?

#### 3. Check upstream dependency changes

```bash
# Compare package.json files we also modify
diff <(git show <previous-upstream-commit>:packages/desktop/package.json) \
     <(git show upstream/dev:packages/desktop/package.json)

diff <(git show <previous-upstream-commit>:packages/app/package.json) \
     <(git show upstream/dev:packages/app/package.json)
```

**Key question:** Did upstream add dependencies that our version of the same `package.json` is now missing?

#### 4. Look for structural changes (file moves, extractions, renames)

```bash
# Files added or removed upstream
git diff <previous-upstream-commit>..upstream/dev --diff-filter=AD --name-only

# Check if any of these overlap with code we reference
```

**Key question:** Did upstream extract code into new files, or delete files we reference?

#### 5. Review upstream interface/type changes in files we implement

```bash
# Check types.ts, interfaces, and shared contracts
git diff <previous-upstream-commit>..upstream/dev -- "*.ts" | grep -A5 -B5 "interface\|type.*=\|export.*type"
```

**Key question:** Did upstream add required properties to interfaces our code implements?

### Resolution Pattern

For each drift issue found:

1. **Missing import/export** → Add the import/export to our file
2. **Changed function signature** → Update our call sites to match
3. **New required interface property** → Implement the property (no-op if not applicable)
4. **Missing dependency** → Add to our `package.json`
5. **Structural change** → Update our imports/references to match new file locations

Commit all drift fixes as a single commit: `fix: resolve upstream drift after YYYY-MM-DD rebase`

---

## Override & Upstream Reconciliation

**After fixing drift issues but BEFORE validation**, review the full upstream changeset and reconcile it with our overrides and claxedo code. This is broader than checking existing overrides — upstream may have added new files, extracted code, introduced new patterns, or deleted things we depend on.

### Why This Step Exists

Real examples of what gets missed without this:
- Upstream fixed a memory leak in `terminal.tsx` by adding cleanup in `onCleanup`. Our override had the same leak for weeks.
- Upstream extracted `session-side-panel.tsx` from `session.tsx`. Our override still had the inline version — worked, but diverged from upstream's module structure, making future syncs harder.
- Upstream added a new `context/comments.tsx` provider that our `directory-layout.tsx` override needed to include in its provider chain. No conflict — just a missing provider.
- Upstream added a shared utility `utils/format-duration.ts` that we independently reimplemented in claxedo code. We could have imported theirs.
- Upstream removed a deprecated API call in `session.tsx`. Our override still called it, producing console warnings.
- Upstream split `layout.tsx` into `layout.tsx` + `layout/sidebar.tsx` + `layout/header.tsx`. Our override of the monolithic file became an orphan.

### Step 1: Get the Full Upstream Changeset

```bash
PREV_SYNC=<previous-upstream-commit>  # from SYNC_LOG.md

# ALL files upstream changed since last sync
git diff "$PREV_SYNC"..upstream/dev --name-only

# Categorize: new files, deleted files, modified files
git diff "$PREV_SYNC"..upstream/dev --diff-filter=A --name-only  # Added
git diff "$PREV_SYNC"..upstream/dev --diff-filter=D --name-only  # Deleted
git diff "$PREV_SYNC"..upstream/dev --diff-filter=M --name-only  # Modified

# Focus on areas we care about
git diff "$PREV_SYNC"..upstream/dev --name-only -- packages/app/src/
git diff "$PREV_SYNC"..upstream/dev --name-only -- packages/ui/src/
git diff "$PREV_SYNC"..upstream/dev --name-only -- packages/sdk/src/
```

### Step 2: Check for New Upstream Files

New upstream files can mean new components, extracted modules, new utilities, or new patterns we should adopt or account for.

```bash
# New files in packages/app/src/ (the package we override)
git diff "$PREV_SYNC"..upstream/dev --diff-filter=A --name-only -- packages/app/src/

# For each new file, ask:
# 1. Is it extracted FROM a file we override? → Our override may need updating
# 2. Is it a new component/context our overrides should use? → Add imports
# 3. Is it a utility we've reimplemented? → Consider switching to theirs
# 4. Is it in a directory where we have overrides? → May need a new override
```

**Key questions for new files:**
- Was this extracted from a file we override? (check `git log --follow` on the new file)
- Does any of our code import from a sibling file that now imports this new file?
- Does this introduce a new provider that should be in our provider chain?
- Is this a utility or helper we've independently built? (search our code for similar function names)

### Step 3: Check for Deleted/Moved Upstream Files

```bash
# Deleted files in packages/app/src/
git diff "$PREV_SYNC"..upstream/dev --diff-filter=D --name-only -- packages/app/src/

# For each deleted file, check if we reference it
for deleted in $(git diff "$PREV_SYNC"..upstream/dev --diff-filter=D --name-only -- packages/app/src/); do
  base=$(basename "$deleted" | sed 's/\.\(ts\|tsx\)$//')
  echo "=== Deleted: $deleted ==="
  grep -r "$base" packages/claxedo-app/src/ --include='*.ts' --include='*.tsx' -l 2>/dev/null
done
```

**Key questions for deleted files:**
- Do our overrides or claxedo code import from this file? → Update imports
- Was this merged into another file? → Update references
- Was this replaced by a new file? → Switch to the replacement
- Do we have an override of this file? → Override is now orphaned, remove or restructure

### Step 4: Review Modified Upstream Files Against Our Overrides

```bash
# Which upstream files that changed have corresponding overrides?
for override in $(find packages/claxedo-app/src/overrides -name '*.ts' -o -name '*.tsx' | grep -v '.test.' | grep -v '.vitest.' | sort); do
  rel="${override#packages/claxedo-app/src/overrides/}"
  upstream="packages/app/src/${rel}"
  changes=$(git diff "$PREV_SYNC"..upstream/dev -- "$upstream" 2>/dev/null)
  if [ -n "$changes" ]; then
    echo "CHANGED: $rel"
  fi
done

# For each, see what upstream changed
git diff "$PREV_SYNC"..upstream/dev -- packages/app/src/context/terminal.tsx
# Compare against our override
diff -u packages/app/src/context/terminal.tsx packages/claxedo-app/src/overrides/context/terminal.tsx
```

### Step 5: Scan for New Patterns & Utilities We Should Adopt

```bash
# New exports added across upstream (new hooks, utils, components)
git diff "$PREV_SYNC"..upstream/dev -- packages/app/src/ | grep "^+export" | head -30

# New files in shared/utility directories
git diff "$PREV_SYNC"..upstream/dev --diff-filter=A --name-only -- packages/app/src/utils/
git diff "$PREV_SYNC"..upstream/dev --diff-filter=A --name-only -- packages/app/src/components/
git diff "$PREV_SYNC"..upstream/dev --diff-filter=A --name-only -- packages/ui/src/

# Check if we have duplicate implementations
# (search our code for function names from new upstream utilities)
```

### What To Look For (Checklist)

Answer these questions across the entire upstream changeset — not just existing overrides:

#### New Upstream Files
- [ ] Did upstream add new files in `packages/app/src/`? → Check if they were extracted from files we override, introduce providers we need, or offer utilities we've reimplemented
- [ ] Did upstream add new components/pages? → Evaluate if our claxedo layouts or overrides need to integrate them
- [ ] Did upstream add new context providers? → Check if our provider chains need updating
- [ ] Did upstream add new utilities? → Search our code for duplicate implementations we can replace

#### Deleted/Moved Upstream Files
- [ ] Did upstream delete or rename files? → Check if our overrides or claxedo code imports from them
- [ ] Did upstream merge files together? → Check if our override of the old file is now orphaned
- [ ] Did upstream split a file we override into multiple files? → Our monolithic override may need restructuring

#### Modified Files We Override — Bug Fixes
- [ ] Did upstream fix bugs? (null checks, boundary conditions, error handling, race condition guards, `onCleanup`) → **Port the fix**
- [ ] Do we have the same bugs in our override? → **Port the fix**

#### Modified Files We Override — Refactors & Code Quality
- [ ] Did upstream refactor functions, extract helpers, rename variables?
- [ ] Did upstream replace patterns (e.g., `createEffect` → `on()` guard, manual tracking → `createMemo`)?
- [ ] Did upstream remove dead code, unused imports, stale comments?
- [ ] Is our override still using old patterns? → **Port the cleanup**

#### Modified Files We Override — New Features & Behavior
- [ ] Did upstream add new functionality (new props, UI elements, event handlers)?
- [ ] Is the new functionality relevant to our override? → **Port it** (or at minimum, don't block it)
- [ ] Did upstream change default behavior or values? → **Evaluate and port if appropriate**

#### Modified Files We Override — Performance
- [ ] Did upstream add memoization, lazy loading, reduce re-renders?
- [ ] Did upstream optimize DOM operations (e.g., CSS `hidden` instead of `<Show>`)?
- [ ] Is our override missing these optimizations? → **Port them**

#### Modified Files We Override — Types & Interfaces
- [ ] Did upstream tighten types, add generics, improve type safety?
- [ ] Did upstream update interface implementations (new required fields)?
- [ ] Is our override behind on types? → **Port the type changes**

#### Modified Files We Override — Dependencies & Imports
- [ ] Did upstream add/remove/change imports?
- [ ] Did upstream start using a new utility or hook?
- [ ] Is our override importing something upstream no longer uses? → **Clean up**

#### Non-Overridden Files That Affect Us
- [ ] Did upstream change files in `packages/ui/`, `packages/sdk/`, or `packages/app-shared/` that our claxedo code imports from? → Check for API changes
- [ ] Did upstream change shared types/interfaces that our claxedo-only code implements? → Update implementations

### Decision Framework

```
UPSTREAM CHANGESET
│
├─ NEW FILE added by upstream
│   ├─ Extracted from a file we override?
│   │   └─ YES → Update our override to import from the new file instead of inlining
│   ├─ New provider/context?
│   │   └─ YES → Add to our provider chains if relevant (directory-layout, pages/layout)
│   ├─ New utility we've reimplemented?
│   │   └─ YES → Replace our implementation with upstream's import
│   ├─ New component in an area we customize?
│   │   └─ YES → Evaluate if we need an override or can use as-is
│   └─ Unrelated to our code? → Skip, no action needed
│
├─ DELETED/MOVED FILE
│   ├─ Do we have an override of this file?
│   │   └─ YES → Override is orphaned. Remove or restructure to match new layout
│   ├─ Does our code import from it?
│   │   └─ YES → Update imports to point to replacement
│   └─ Neither? → Skip
│
├─ MODIFIED FILE that we override
│   ├─ Change in a section we DON'T modify?
│   │   └─ Port it directly (copy the changed lines)
│   ├─ Change in a section we DO modify?
│   │   ├─ Bug fix? → Port it, adapting to our modifications
│   │   ├─ Refactor? → Port the pattern if it improves our code
│   │   ├─ New feature? → Port if compatible, skip if conflicts with our intent
│   │   └─ Cosmetic? → Skip unless it improves readability
│   ├─ Upstream DELETED code we still have?
│   │   ├─ Dead code? → Delete from our override too
│   │   ├─ Deprecated? → Delete, use replacement
│   │   └─ We still need it? → Keep, document why
│   └─ Upstream ADDED code we don't have?
│       ├─ In a function we override? → Merge into our version
│       ├─ New function/component? → Add it (we're a superset)
│       └─ Conflicts with our extension? → Skip, document why
│
└─ MODIFIED FILE we don't override but depend on
    ├─ API surface changed (exports, signatures, types)?
    │   └─ YES → Update our import sites / call sites
    └─ Internal-only change? → No action needed
```

Use this framework as a filter, not a script. Bug fixes, reliability fixes, safety fixes, and useful shared patterns should usually be ported. Cosmetic churn and upstream behavior that conflicts with fork intent can be skipped, as long as the skip is deliberate and documented.

### Step 6: Apply Changes

```bash
# For existing overrides — port upstream improvements
# Edit: packages/claxedo-app/src/overrides/context/terminal.tsx

# For new upstream files that need overrides — create new override
cp packages/app/src/components/new-thing.tsx packages/claxedo-app/src/overrides/components/
# Edit the override, Vite picks it up automatically

# For orphaned overrides — remove or restructure
rm packages/claxedo-app/src/overrides/components/removed-thing.tsx

# For duplicate utilities — replace with upstream import
# Find: our custom formatDuration() in claxedo code
# Replace with: import { formatDuration } from "@/utils/format-duration"

# After all changes, verify
bun run --cwd packages/claxedo-app typecheck
```

### Step 7: Document What Changed

Add a section to the sync log entry:

```markdown
### Override & Upstream Reconciliation
**New upstream files reviewed:** 3
- `app/src/components/session-side-panel.tsx` — extracted from session.tsx, created new override
- `app/src/utils/format-duration.ts` — replaced our custom implementation in claxedo
- `app/src/context/comments-store.ts` — new file, no action needed (not in our scope)

**Deleted upstream files:** 1
- `app/src/components/old-terminal.tsx` — removed our override, was orphaned

**Overrides updated:** 4
- `context/terminal.tsx`: Ported cleanup leak fix, adopted `on()` guard pattern
- `context/global-sync.tsx`: Ported dead code removal, updated error handling
- `pages/session.tsx`: Ported keyboard shortcut handler, skipped UI change (conflicts with split view)
- `context/server.tsx`: Upstream refactored fetch logic — ported, adapted for transformUrl

**Overrides unchanged:** 2
- `components/settings-general.tsx`: No upstream changes
- `utils/persist.ts`: No upstream changes

**Skipped (documented):**
- `pages/session.tsx`: Skipped upstream's new sidebar toggle — conflicts with our split panel system
```

### Override File Map (Quick Reference)

| Override | Upstream | Why Overridden |
|----------|----------|----------------|
| `app.tsx` | `app/src/app.tsx` | Extension system integration |
| `bus/bus-event.ts` | `app/src/bus/bus-event.ts` | Custom event types |
| `components/prompt-input.tsx` | `app/src/components/prompt-input.tsx` | Extended prompt features |
| `components/session.ts` | `app/src/components/session.ts` | Session component swap |
| `components/session/session-new-view.tsx` | `app/src/components/session/session-new-view.tsx` | Cloud workspace UI |
| `components/settings-general.tsx` | `app/src/components/settings-general.tsx` | settingsSections extension |
| `components/status-popover.tsx` | `app/src/components/status-popover.tsx` | serverSelectorMode |
| `context/global-sync.tsx` | `app/src/context/global-sync.tsx` | onServerChange hook |
| `context/language.tsx` | `app/src/context/language.tsx` | Extension strings merge |
| `context/layout.tsx` | `app/src/context/layout.tsx` | Context consistency |
| `context/notification.tsx` | `app/src/context/notification.tsx` | Context consistency |
| `context/platform.tsx` | `app/src/context/platform.tsx` | openLink override |
| `context/prompt.tsx` | `app/src/context/prompt.tsx` | Context consistency |
| `context/server.tsx` | `app/src/context/server.tsx` | transformUrl extension |
| `context/terminal.tsx` | `app/src/context/terminal.tsx` | Server-scoped persist, cwd tracking |
| `pages/directory-layout.tsx` | `app/src/pages/directory-layout.tsx` | directoryProviders, resolveSessionUrl |
| `pages/home.tsx` | `app/src/pages/home.tsx` | webProjectDialog, serverSelectorMode |
| `pages/layout.tsx` | `app/src/pages/layout.tsx` | layoutComponent extension |
| `pages/session.tsx` | `app/src/pages/session.tsx` | Split view, panel overrides |
| `utils/persist.ts` | `app/src/utils/persist.ts` | Server-scoped storage |

Files in `overrides/` with **no upstream counterpart** (claxedo-only):
- `context/global-sync/*.ts` (child-store, bootstrap, event-reducer, session-load, types)
- `context/layout-projects.ts`, `context/layout-project-lifecycle.test.ts`
- `context/terminal-shared.ts`, `context/file/view-cache.ts`
- `pages/session/history-window.ts`, `pages/session/terminal-panel.tsx`, `pages/session/use-session-commands.tsx`
- `terminal/**` (entire terminal subsystem — backend swap, link parsing, link providers)
- `utils/debug.ts`

These claxedo-only files don't need upstream comparison but should be reviewed for imports/types that upstream may have changed.

Commit all freshness updates as: `chore: port upstream improvements to overrides after YYYY-MM-DD rebase`

---

## Validation After Rebase

After resolving all conflicts and reviewing upstream drift:

### Step 1: Install Dependencies

```bash
bun install
```

### Step 2: Type Check

```bash
bun run --cwd packages/claxedo-app typecheck
```

### Step 3: Run Tests

```bash
bun run --cwd packages/claxedo-app test
```

### Step 4: Build Check

```bash
# For fork app
bun run --cwd packages/claxedo-app build

# For opencode core when touched
bun run --cwd packages/opencode build
```

### Step 5: Verify Extension System

```bash
# Check that extension points are still wired correctly
grep -r "getExtensions()" packages/app/src/ | head -10

# Verify overrides are in place
ls -la packages/claxedo-app/src/overrides/
```

### Step 6: Run Targeted Confidence Checks

Do not blindly run every possible test. Do run a small set of checks that matches the areas touched.

- If session, prompt, or timeline changed: verify open session, send prompt, and basic review or todo flow
- If terminal changed: verify terminal create, focus, and restore behavior
- If settings or layout changed: verify the touched settings screen or layout path
- If shared types or server/runtime code changed: run the relevant `packages/opencode` typecheck and build

---

## Documentation Updates

After successful rebase, update these files:

### 1. CLAXEDO_UPSTREAM_SYNC.md

Update the version compatibility table:

```markdown
| Claxedo Version | Upstream Commit | Last Sync Date |
|-----------------|-----------------|----------------|
| dev | $(git rev-parse --short upstream/dev) | $(date +%Y-%m-%d) |
```

### 2. SYNC_LOG.md (Create if doesn't exist)

Add entry for this sync:

```markdown
## $(date +%Y-%m-%d)

- **Sync Branch:** sync/$(date +%Y-%m-%d)
- **Previous Upstream Commit:** <sha>
- **Upstream Commit:** $(git rev-parse --short upstream/dev)
- **Mode:** Full rebase / targeted carryover
- **Status:** Success / Partial / Failed
- **Key Decisions:**
  - File X: Ported
  - File Y: Skipped (reason)
- **Validation:** commands run + outcome
- **Follow-up:** only unresolved work
```

### 3. If New Files Modified

Add to "Upstream Modifications Registry" in CLAXEDO_UPSTREAM_SYNC.md with appropriate merge strategy.

---

## Red Flags (Escalate to Human)

**STOP and request human review if:**

1. **Upstream added their own plugin/extension system**
   - May conflict with our extension system
   - Requires architectural decision

2. **Upsteam refactored core context architecture**
   - Changes to Provider hierarchy
   - New context patterns

3. **Function signatures we depend on changed**
   - Extension points may need updates
   - Could break claxedo-app

4. **Major dependency version changes**
   - Breaking changes in core deps (SolidJS, Vite, etc.)
   - Requires testing

5. **Conflicts in >5 files simultaneously**
   - May indicate upstream refactoring
   - Batch resolution risky

6. **Unclear conflict origin**
   - Can't determine why file was modified
   - May be accidental change

7. **Build fails after resolution**
   - Type errors
   - Runtime errors in dev server

8. **Upstream restructured files we override or depend on**
   - Components extracted into new files
   - Modules split or merged
   - These won't cause conflicts but WILL cause silent breakage
   - The Upstream Drift Review section catches these

---

## Quick Reference

### Git Commands

```bash
# Check rebase progress
git status
git diff --name-only --diff-filter=U

# See conflict details
git diff

# Abort rebase (if stuck)
git rebase --abort

# Skip current commit
git rebase --skip

# Continue after resolution
git rebase --continue
```

### Conflict Resolution Shortcuts

```bash
# Keep our version
git checkout --ours <file>
git add <file>

# Keep upstream version
git checkout --theirs <file>
git add <file>

# Mark resolved manually
git add <file>
```

### Key Files to Monitor

- `packages/app-shared/src/extension-points.ts` - Extension API
- `packages/app/src/app.tsx` - Extension integration
- `packages/app/src/context/*.tsx` - Context providers
- `packages/claxedo-app/src/overrides/**` - Our overrides

---

## Related Documentation

- [CLAXEDO_UPSTREAM_SYNC.md](../packages/claxedo-app/.dev-docs/CLAXEDO_UPSTREAM_SYNC.md) - Detailed sync guide
- [ARCHITECTURE.md](../packages/claxedo-app/.dev-docs/ARCHITECTURE.md) - Claxedo app architecture
- [AGENTS.md](./AGENTS.md) - General coding guidelines
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines

---

*This document is maintained by the Rebase Agent. Last updated: 2026-02-07*
