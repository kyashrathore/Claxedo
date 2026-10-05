# Claxedo web UX principles (binding for every UI lane)

Owner (2026-10-05): "extreme smooth, predictable, not intimidating/daunting, easy to navigate and intuitive ux flow". No
backward compatibility — delete and rebuild freely; no shims.

1. One vocabulary, plain words. Project · cloud workspace · this computer · machine · harness · model · session. Never show
   internal ids (ws_…, prj_…, ses_…) as primary text; never show internal jargon (Native SDK, code-host, work-source, agent
   connections, placement, lease, sandbox for the user's workspace). Ids only in a tooltip/secondary detail when useful.
2. Show only what applies here. The web never shows desktop-only states ("Scanning this machine", local CLI quotas, "Sign in"
   when signed in). Hide sections that have nothing to offer instead of showing disabled/"not available yet" blocks.
3. Every state is explicit: loading (after 50 ms, skeleton matching the final layout, keep cached data visible while
   refreshing), slow (after ~2 s say what it waits for: "Starting the cloud workspace — about a minute"), empty (a sentence +
   the one action that fixes it), error (what happened in plain words + Retry/next step). Never a silent revert, never a
   blank screen, never a spinner-looking decoration.
4. One primary action per surface; secondary actions quieter. Forms that create or connect things are dialogs, not inline
   expansions inside lists. A field's label sits above it; help text is a short description under the label, not under the
   input.
5. Predictable: nothing starts, stops, or costs money without the user seeing it happen (say "Starting…", show running VMs
   and their usage). Navigation keeps context (return to where you were; don't wipe lists you've already loaded).
6. Visual restraint: no AI-slop decoration — no colored accent left borders/brackets, no loud tinted warning boxes for
   routine notes, no hover underlines on list rows, consistent icons (one cloud icon), even padding, consistent type
   hierarchy (empty/hint text quieter than content), real contrast (enabled items never look disabled).
7. Fewer things: merge duplicate concepts and chips; remove headings that repeat the page title; collapse rarely-used options.
8. Prove it: every changed surface gets a Playwright check (web + phone viewports) and a before/after screenshot in the lane
   report; tests exercise real behavior.

## Form & control system (decided 2026-10-05, owner asked for repo-wide decisions)
9. Field anatomy, top to bottom: Label (sentence case) → optional description (muted, one line, under the label, ABOVE the
   input) → input → error (under the input, plain words, says how to fix). Required is the default; optional fields append
   "(optional)" to the label. No asterisks.
10. Placeholder = an example of the expected value in its format (e.g. "https://github.com/owner/repo", "checkout-flow"),
    never instructions or a description. Empty when there is no useful example.
11. A field with two input modes (choose from GitHub vs paste a URL) uses a segmented control above the field
    ("From GitHub | Paste URL"), default "From GitHub" when GitHub is connected. Never a plain-text link that doesn't look
    clickable.
12. Dropdown/popover footer actions: a divider above the footer only when list items sit above it; the action has a "+"
    icon; label ends with "…" when it opens a dialog ("Create project…", "Connect a machine…"), no ellipsis when it acts
    immediately.
13. Sidebar session rows (Activity and Projects): two lines — title on line 1; meta on line 2 (project · where · age).
    Icons are text-sized (match the 13–14 px text), muted.
14. In-flight actions keep their surface open and show progress in place (e.g. user menu stays open showing "Signing out…"
    until done). Never close a menu then freeze.
15. Copy never says "this server"/"this machine" on the web; name the real thing (Claxedo, your GitHub account, the machine's
    name).
16. One notice slot above the composer. It shows the single most important notice (error > blocking setup > waking/
    lifecycle > info), with "+N more" to expand; duplicates merge; never a stack of unrelated cards by default. Every notice
    names a real destination ("Settings → Models", not a page that doesn't exist).
17. Waking a cloud workspace on send: the notice slot shows the lifecycle in place ("Waking <name> — starting the machine,
    about a minute" → "Restoring files" → "Connecting"), driven by real start phases; the user's message shows in the
    transcript as pending and is sent when ready; failure turns the strip into the error with Retry.
18. Where forms open: short create/connect forms (1–2 fields) open in a centered dialog; longer or explanatory forms (e.g.
    Add plugin source: explanation + repository + ref) open in a right-side drawer. Never inline expansion inside a list or
    page. One component each (Dialog, Drawer) reused everywhere.
