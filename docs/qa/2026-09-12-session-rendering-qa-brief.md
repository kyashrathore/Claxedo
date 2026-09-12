# QA brief: session transcript, composer and rail (first pass)

You are testing Claxedo's chat surface for the first time: the transcript where an agent's work is shown, the composer where you type, and the rail listing your sessions. A large wave of fixes landed this week across every part of it, on every harness, on desktop and web, local and cloud. Most of it was verified by automated tests and a few live runs. Nobody has used it end to end as a person yet. Assume things are broken and try to make them break.

You do not need to know the code. You need to notice when something feels off and write down exactly what you did.

## How to report

For every finding, capture:

- Surface: desktop app or web; local session or cloud session.
- Harness: Claude, Codex, Cursor, Pi, or OpenCode (shown on the session; ask if unsure).
- What you did, step by step, including timing ("clicked while it was still streaming").
- What you saw versus what you expected.
- A screen recording if anything moved, flickered, jumped, or appeared twice. Screenshots miss all of those.
- The session title or link, so the transcript can be pulled.

Small things count. "The title flickered once" or "the row moved a few pixels" is a valid report. Two identical blocks of text is a serious report.

## Rules of thumb for what "off" means

- Nothing on screen should move unless you moved it. Sending a message, switching sessions, a tool finishing, a subagent starting: none of these should shift, jump, or reflow what you were reading.
- Nothing should render twice. Text, tool rows, subagent chips, question cards.
- Every tool row should say what it is and be openable, even while it is running.
- The session list should only reorder when you send a message to a session. Clicking a session must not move it.
- Sending while the agent is working should never stop the agent.

## Part 1: Composer and sending

1. Send a message while the agent is mid-turn on Claude. It should be handed into the running turn without an abort. Expect a short pause and the agent picking up your addition. Watch for: the turn stopping, the old reply vanishing, a "Queued" label that never clears, your message appearing twice.
2. Repeat on Codex. Then on Cursor (Cursor should show "Queued" and run it after the current turn ends). Then on Pi and OpenCode if you have them.
3. Send three messages in a row while a turn is running. They should run in the order you sent them, one after the other, with nothing dropped.
4. Send one while a turn is running, then kill the app or restart the server, then reopen. The queued message should still run, or at least still be visible as pending, without any request from you.
5. Watch the "Thinking…" indicator when you send. It should appear once and stay until the reply starts. Watch for: it appearing, disappearing, and reappearing.
6. Watch the composer and the transcript as you press send. Nothing above the composer should jump.
7. Press Stop mid-turn. The turn should end promptly, the row should show it was interrupted, and the composer should be usable. Press Stop a second time right after: nothing should break.
8. Send, then very quickly press Stop, then send again. The stop must only hit the turn you were looking at, never the new one.
9. Paste or drag an image into the composer on a local session, send, and confirm the agent actually received it (ask it to describe the image). Then a PDF. Then a video or a random binary. On a local session everything should be accepted and the agent should be told where the file is. On a cloud session, images and PDFs should work and anything else should be refused with a message that names the harness and the file type.
10. Add an image to the composer, then switch to another session before sending. The image must stay with the session you attached it to and must not appear in the other session or in a new thread.
11. Type a draft, switch sessions, come back. The draft should be exactly where you left it, in that session only.

## Part 2: The transcript while a turn runs

12. Watch a shell command run. The row should say "Running" with the actual command beside it from the first moment, and you should be able to open it while it runs. Watch for: a bare "Running" with no command, a row that ignores clicks, an arrow that opens an empty panel.
13. Open a running tool, then let it finish. Its output should appear in place without the row collapsing or jumping.
14. Let a long tool-heavy turn run. With the default settings, groups of tool calls should fold when the turn settles. Turn on "fold while running" in Settings and check it folds live; turn it off and check it stops.
15. Expand a tool card inside a group, then let the turn fold. Automatic folding should leave your expanded card alone. Folding the turn by hand should hide it.
16. Let a turn get interrupted or fail. The fold control should still be there and you should still be able to collapse or expand it.
17. Watch the text of a long reply as it streams. Read the final reply carefully. Any sentence or paragraph appearing twice is a bug, even partially. Check on Claude especially, and check subagent replies.
18. Watch a reply that produces a long list or table. It should paint whole. Watch for: a list that shows a few rows and grows afterwards, or rows that appear and then disappear.
19. Look at the shimmer on the running row. Only the live row should shimmer. Scroll through a long session and check that finished rows are not still animating.

## Part 3: The transcript after a turn

20. Open a shell row with long output. You should see a scrollable box with a visible scrollbar and a "Show all" control under it. Click it: the whole output should be readable in place, the row should not collapse, and "Show less" should restore the box. Try it on list, grep, glob, a generic tool, and a subagent result. Try it on a row whose output is short: there should be no control at all.
21. Run a command that fails (for example `false` or `ls /nonexistent`). The row should show "exit N" beside the command. A failing test suite should read as a failure, and a grep with no matches should not look like a crash. Check on Claude, Codex, and Cursor separately; they report this differently.
22. Make the agent run a dev server. A "Local preview" row with the localhost address should appear under the shell row. Clicking it should open a Browser tab in the app, not a system browser, and that tab must survive you navigating to another session and back.
23. Get the agent to print a `file://` path, a `vscode://` link, and a `claxedo://` link in prose. All three should be links. `file://` should open the path on your OS, the others their app. On the desktop app, also check these in a reply rendered by the native renderer (long replies).
24. Get the agent to embed an image by `file://` path in markdown. It should render.
25. Ask the agent a question that makes it ask you one back (the question tool). Answer it. The answered question should stay as its own card showing what you chose or typed. Dismiss one instead of answering: it should say it was dismissed, not look like an error. Navigate away and back: the card must not flash or reopen.
26. Ask the agent to use a skill. The skill row should be clickable and show its output. Ask it to run several tools of one kind in a row (two MCP calls, two skills); the group header should name them, not just say "Worked".
27. Look at tool names on Claude sessions. `Read`, `Bash`, `Agent`, `LS` should render with the same look and grouping as the lowercase equivalents on other harnesses.

## Part 4: Subagents

28. Ask the agent to delegate work to subagents (Claude "Agent" tool, Codex or Cursor equivalents). Each spawn should appear once as a chip. Watch for: chips appearing twice, a chip for a task that does not exist, rows with nothing in them, a chip that does not open.
29. Click a chip. The subagent's transcript should open as a tab in the workspace panel, not as a split beside the transcript. Close it and reopen it.
30. Let a subagent ask a permission or a question. You must be able to answer it from its tab; the answer area must not be missing.
31. Let a subagent fail or be refused. It should show as an error card, not an empty row.
32. Fold the parent turn. Subagent chips should stay visible under the fold.
33. Run something with a background task (a long shell in the background). It must not create a phantom subagent row or a dead "Thinking" tab.

## Part 5: Session list and navigation

34. Click through several sessions quickly. No row should move. Then send a message in one: only that row should move, to the top of its section.
35. Let an agent finish a turn, spawn a subagent, or receive a scheduled wake in a session you are not looking at. That row must not move.
36. Switch between two long sessions repeatedly. Watch the title, the loader, and the content. Nothing should shift, the title should not flicker between loader and text, and folds should already be decided when the content appears.
37. Scroll a long transcript as fast as you can with the wheel and the scrollbar. Some blank area during a very fast fling is expected; blank that stays after you stop, or content that swaps under the pointer, is not.
38. Open a file, the review pane, or the browser tab from the transcript. It should open the surface you asked for. Watch for it opening a different panel or switching your chosen panel to another one.

## Part 6: Environment sweep

Repeat a handful of the above in each of:

- Desktop app and web.
- Local session and cloud session.
- Light and dark theme, and a narrow window.
- Two or three non-English locales (German, Japanese, Arabic). Watch for English leaking into labels like "Queued", "Show all", "exit N", and for layout in a right-to-left locale.

## Known limits, so you do not report them

- Sending while a turn runs on Cursor queues instead of steering; that is by design.
- On cloud sessions only images and PDFs can be attached.
- Pi and Cursor steering have not been run live by us yet; if you have keys for them, they are the highest-value thing to try.
- Very fast scrolling can show blank rows for a frame; it is measured and accepted.

## Part 7: Turn folding, consistency checks

These are the rules the code promises. Every check is "does the same thing happen every time, on every harness".

The rules:

- A finished turn folds itself when it has at least two foldable groups. One group never folds.
- A running turn folds itself only if "fold while running" is on in Settings, and only from three foldable groups. While it folds live, the newest group stays visible.
- Foldable means: a run of shell, edit, write, fetch and similar tools; a run of read, glob, grep and list; a single tool standing on its own. Not foldable, ever: the agent's prose, its reasoning, subagent chips, and questions.
- An interrupted or failed turn keeps its fold control but never folds itself. It explains itself, so it stays open.
- Your own click always wins. If you expanded a turn, nothing re-folds it. If you folded a running turn by hand, that hides the live group too. Automatic folding never hides the live group.
- A turn whose only machinery is subagents does not fold at all, because there is nothing to hide.

What to try:

39. Produce a turn with exactly one tool group and a reply. It must stay open. Then one with two groups: it must fold when the reply finishes, and the prose must stay visible above and below the fold.
40. Produce a long turn on Claude, then the same task on Codex, Cursor, Pi and OpenCode. Count the groups you see and the groups hidden by the fold. The counts should follow the rules above on every harness. A harness that never folds, or folds a single group, is a bug.
41. Turn "fold while running" on. Start a tool-heavy turn. It must not fold until the third group. When it does, the group currently running must still be on screen. Turn the setting off mid-turn and confirm folding stops without unfolding what you already folded.
42. Expand a folded turn, then send a message in the same session so a new turn runs and settles. The turn you expanded must stay expanded.
43. Fold a running turn by hand, then wait for it to finish. It must stay folded after it settles, and the fold count in the header must be right.
44. Press Stop mid-turn on each harness. The interrupted turn must keep its fold control, stay open, and be collapsible by hand. Then expand it, press Stop on another turn, and check the first one did not change.
45. Make a turn fail (bad model, revoked key, killed process). Same expectations as an interrupted turn. Check that the failed card is light, not a heavy red block.
46. Switch away from a session with a folded turn and back. It must be folded on the first paint, not open and then snap shut. Do this on a cold start of the app too.
47. Look for the fold row's label verb. A running turn says it is working; a settled, interrupted or failed one does not. A turn that is busy but already failed must not say "working".
48. Answer a question inside a turn, let the turn finish and fold. The answered question card must stay visible outside the fold, and must not count toward the fold's group total.

## Part 8: Tool grouping, consistency checks

The rules:

- Consecutive read, glob, grep and list calls form one context group, collapsed until opened, with a summary of what was read.
- Consecutive calls of everything else that does work (shell, edit, write, patch, fetch, search, skills, MCP tools) form one work group with a header naming what was done.
- Consecutive subagent spawns form one chip row.
- A question is always on its own, never inside a group.
- Any prose or reasoning between tool calls ends the group.
- Harness spellings are normalised before grouping: `Agent`, `subagent`, `spawn_agent`, `create_subagent` are all a subagent; `command`, `shell`, `local_shell` are all shell; `read_file`, `write_file`, `edit_file` are read, write, edit; `LS` is list; `AskUserQuestion` is a question; `web_search` is web search.
- A to-do write renders no row at all; it feeds the to-do surface instead.

What to try:

49. Get each harness to read three files in a row. You should see one collapsed context group with a count, not three rows. Open it: three rows inside. Then read, run a command, read again: that should be three groups (context, work, context), never one.
50. Get each harness to run two shell commands, then edit a file, then run another command. One work group. Its header must reflect a mix, not just the first tool.
51. Get the agent to call two skills in a row, or two MCP tools in a row, with no shell in between. The group header must name them. "Worked" with a terminal icon over two skill calls is the old bug.
52. Interleave: shell, a sentence of prose, shell. Two groups with the sentence between them. The sentence must not be swallowed.
53. On Claude, confirm `Read`, `Bash`, `LS`, `Agent` group and render exactly like `read`, `bash`, `list`, `task` on Codex. Look at icons, header verbs and counts side by side.
54. On Codex, a `local_shell` or `command` call and on Cursor a `shell` call must look like a shell row: "Ran <command>", terminal icon, output box, exit code on failure.
55. Ask the agent to write a to-do list. No row should appear in the transcript for that call; the to-do surface should update instead. Then ask it to update the list several times: still no rows.
56. Find the header label of a collapsed work group whose command is very long. It should truncate cleanly, and opening the group should show the whole command.
57. Spawn two subagents back to back, then run a shell command, then spawn another. Two chip rows with a work group between them, never one chip row of three.

## Part 9: Content shift, where to look

Nothing on screen should move unless you moved it. These are the moments when something is most likely to move.

58. First paint of a session: fold state, title, and the "thinking" state must all be right on the first frame. Watch for a flash of the open state before the fold, or the title flipping from loader to text to loader.
59. Send: the composer should not jump, the transcript above it should not scroll, and "Thinking…" should appear once.
60. The reply's first token arriving: the row should grow downward only.
61. A tool row completing: the row keeps its height; output appears inside it; the exit code chip or the "Local preview" row appearing below must not scroll the view.
62. A tool row's shimmer ending: the text must not shift by a pixel when the swept copy is removed.
63. "Show all" on a long output: the block grows in place; the viewport must not jump to the top or bottom of the block, and rows below must move down smoothly, not blink.
64. A question card resolving: same footprint before and after, no flash on navigating back.
65. A subagent chip arriving mid-turn: the chip row appears without the prose around it moving.
66. A list or table streaming in: it should not paint short and then grow rows in later frames.
67. An image thumbnail loading: the space should be reserved so the text below does not jump when the image arrives.
68. A diff rendering in an edit row: same, the row should not resize after the diff appears.
69. Fast scroll and stop: blank rows may appear during a fling; once stopped, nothing should fill in under your pointer or change height.
70. Switching between two sessions repeatedly: measure by eye whether the same row lands in the same place each time.

Record every one of these; a screenshot cannot show a shift.

## Part 10: Surfaces across harnesses

The to-do list, the question card, the permission dock and the subagent chips each come from a different place on each harness. The rule is that they must look and behave identically regardless of which harness produced them. Where a harness has no such surface, nothing should appear.

| Surface | Claude | Codex | Cursor | Pi | OpenCode |
|---|---|---|---|---|---|
| To-do list | yes (its task list) | yes (its plan) | yes (its to-dos) | none | yes |
| Question card | yes | yes | check | yes | check |
| Permission dock | yes | yes | yes | yes | yes |
| Subagent chips | yes | yes | yes | none | none |
| Send mid-turn | steers | steers | queues | steers | steers |

"check" means we do not know whether that harness ever asks; if it does, it must render as the same card.

What to try, per harness:

71. To-do: ask the agent to plan a five-step task and work through it. The to-do surface should show the steps, tick them as they complete, and never show a phantom or duplicated step. When the turn ends, the list must reflect the final state. On Pi nothing should appear.
72. Question: ask something that makes the agent ask you back with options. Answer with an option, then in a second run type a free answer, then in a third dismiss it. The card must show what you chose, verbatim what you typed, and a dismissal that is not styled as an error. Same three cases on each harness that supports it.
73. Question while a subagent is running: the question must reach you and be answerable in the subagent's tab.
74. Permission: run something that needs approval (a write outside the workspace, a network call, a destructive command, depending on the harness's rules). The dock must appear, name the tool and the target, and allow or deny must take effect immediately. Deny, then confirm the agent reports the denial rather than pretending it ran. Do this on every harness; Pi and Cursor are the least exercised.
75. Permission on a subagent: same, from the subagent's tab. The dock must not be hidden by the read-only state of that tab.
76. Permission with a ceiling: if your session has a permission ceiling set (ask), an action above the ceiling must be refused with a clear reason, not silently allowed.
77. Subagents: spawn one on Claude, Codex and Cursor. One chip each, opening in a workspace-panel tab, with a live transcript. When the subagent finishes, the chip must show it, and the parent turn must continue. On Pi and OpenCode, a task-like tool must not produce a chip.
78. Subagent refused or failed: an error card, not an empty row. Subagent nested two deep on Claude: chips at both levels, each opening its own tab.
79. Background task on Claude (a long-running shell in the background): no chip, no dead "Thinking" tab, and its completion must not spawn a row.
80. The same prompt, all five harnesses, side by side: do the four surfaces look the same? Different wording is fine; different shape, placement or behaviour is a finding.

## Part 11: Heavy sessions, scrolling and blanking

What the code does: the transcript renders only the rows near the viewport plus a band of six rows beyond it. Rows are measured as they mount. On a cold open of a session the band starts at one row and widens to six once the first measurements exist. Measured on the perf harness: a flick at 1,400 px per frame leaves no blank area; a flick at 5,600 px per frame leaves about 800 px blank for the skipped frames only. So: blank during a violent fling is accepted; blank that persists, blank at ordinary speed, or content that changes under a stopped pointer is not.

Build a heavy session first: a long agentic task with hundreds of tool calls, several subagents, a few large outputs, images and diffs. Keep it; every check below uses it. Do it on at least two harnesses.

81. Scroll with the wheel at reading speed from top to bottom. There must be no blank rows at any point.
82. Drag the scrollbar thumb slowly, then quickly, then throw it. Slow and quick must show no blank. A throw may show blank while moving; the moment you stop, every row on screen must be painted within a frame or two, and nothing already painted may change.
83. Fling with a trackpad as hard as you can, stop with a finger. Same expectation. Then do it again immediately: the second fling must not be worse than the first.
84. Press End, then Home, then End. Both ends must paint fully. The bottom must show the last message and the composer, with no gap.
85. Use the scroll-to-bottom button from the top of the heavy session. It must land on the last row painted, not on a blank that fills in.
86. Scroll while the session is still streaming. New rows arriving at the bottom must not blank rows in the middle, and must not pull the view down unless you were already at the bottom.
87. Scroll through a region dense with folded turns, then through the same region with those turns expanded. Expanding must not introduce blanking; the band is the same.
88. Open a large tool output with "Show all" deep in the session, then scroll away and back. The row must still be expanded and painted, not blank or re-collapsed.
89. Scroll through the subagent chip rows and the image thumbnails at speed. Chips and images must not appear as empty boxes that fill in later at normal speed.
90. Watch memory and heat: leave the heavy session open for ten minutes with a turn streaming, scrolling occasionally. The app must not get slower to scroll over time. Report if a scroll that was smooth at minute one stutters at minute ten.
91. Narrow the window to a phone-like width and repeat 81 and 82. Row heights change; blanking must not.
92. Dark theme, repeat 82. Blank rows are easier to see against a dark ground; report anything you did not see in light.

## Part 12: Cross-session navigation

What the code does: on a switch back to a session you have seen, the transcript restores the fold counts that visit rendered so the first frame is folded. On a session opened for the first time it takes the counts from the page prefetched for the rail, so it can still fold on its first paint. The title latches once named. A session's scroll position is not stored; a switch lands at the bottom for a live session and at the top otherwise. Drafts and attachments are per session. Browser tabs and subagent tabs survive a switch.

93. Open the heavy session, scroll to the middle, switch to another session, switch back. Expect the bottom (if the session is live) or the top, painted fully on the first frame, with folds already applied. Report a flash of unfolded content, a blank first frame, or a title that changes after paint.
94. Open a session you have never opened in this app install. Folds must be right on the first frame, from the prefetched page. Then reload the app and open it again: same.
95. Switch rapidly between five sessions with the keyboard or the rail, faster than they can load. Nothing should end up in the wrong session: no title from A over transcript of B, no draft from A in B's composer, no "Thinking…" from A shown on B, no fold state from A applied to B.
96. Switch away from a session with a running turn and back. The running row must still shimmer, the fold-while-running state must be what it was, and the "Thinking…" indicator must be right for that session only.
97. Switch away from a session whose question is pending, answer it from a notification or from the other session's context if possible, come back. The card must show it resolved, without a flash of the pending state.
98. Switch away while a permission is pending. The dock must be there when you return and must still work.
99. Open a Browser tab from a local preview row, switch sessions, switch back. The tab must still be open on the same page. Open a subagent tab, same.
100. Open a file in the workspace panel from session A, switch to B, open a different file, switch back to A. The panel must show what A had open, not B's file.
101. Deep-link into a session (paste its link into the address bar, or open it from a notification). It must open that session, fully painted, with the rail row selected, and the row must not move.
102. Delete or archive a session you are looking at from the rail. The view must move to a sensible neighbour, not a blank pane, and the rail must not reorder beyond removing the row.
103. Use browser back and forward on the web app across several session switches. Each step must land on the right session, painted, with no leaked state.
104. Have two windows or tabs on the same session. Send from one; the other must show the message and the reply without duplicating either, and its rail must reorder the same way.
105. Cloud session with the workspace stopped: open it from the rail. The transcript must show, read-only or with a clear "starting" state, without blank rows or a spinner that never ends. Switch away and back while it starts.
