# Fix commits mined into corpus cases

Every commit with "fix" in its subject since 2026-08-01 that touched the renderers (`packages/session-ui/src/components`, `src/pierre`) or the timeline. Each row ends as a case in `cases/*.json`, is covered by a named existing case, or is not a rendering behavior (with the reason).

| Commit | Date | Subject | Outcome |
| --- | --- | --- | --- |
| `afb077880e` | 2026-09-23 | fix(transcript): a reader's click ends the finished turn's settle window | pending |
| `5963c90762` | 2026-09-23 | fix(session): an upward scroll at the top of a short session pages its older turns | pending |
| `883f30b8ab` | 2026-09-23 | fix(handoff): mark a harness switch on the message that crosses it | pending |
| `5fff648b2d` | 2026-09-23 | fix(session): a reloaded short session shows the row that reaches its older turns | pending |
| `2ad6f6adb7` | 2026-09-23 | fix(session): drop the spinner beside the session title | pending |
| `6c7e328be5` | 2026-09-23 | fix(transcript): the first reply row is followed to its end, whether it streams or lands with the idle | pending |
| `87ae518aeb` | 2026-09-23 | fix(transcript): a working turn paints its fragment, and an early idle keeps it active | pending |
| `59eb33db3f` | 2026-09-23 | fix(session): a press on the previous-messages row keeps the composer's focus | pending |
| `3f5e2f63c9` | 2026-09-23 | fix(review): a diff header is keyed by its review file, not by Pierre's parsed name | pending |
| `d2fa575915` | 2026-09-23 | fix(transcript): a history reveal anchors on a turn, and a late prefetch stays hidden | pending |
| `7a0148fced` | 2026-09-23 | fix(session): peekable Goal card and a quieter read-only subagent pane | pending |
| `bf0ed90e61` | 2026-09-23 | fix(transcript): a scroll gesture keeps the place a history reveal owes | pending |
| `8221342197` | 2026-09-22 | fix(app,session-ui): clear the last oxlint findings in the app and review view | pending |
| `4c492991dc` | 2026-09-22 | fix(lint): drop redundant type assertions and default type arguments | pending |
| `347cfe7eb4` | 2026-09-22 | merge: dev into refactor/runtime-recovery | pending |
| `d681424426` | 2026-09-21 | fix(session): rebuilding a range asks the right question of it | pending |
| `f50fc92648` | 2026-09-21 | fix(security): P-68 P-69 P-78 S-2 markdown/link/mermaid sanitization | pending |
| `884c76ad58` | 2026-09-21 | fix(recovery): the session tool card reads the stop, not the operation state | pending |
| `6f67ceb946` | 2026-09-21 | fix(security): P-79 card link hrefs validated at the boundary | pending |
| `33883015ff` | 2026-09-21 | fix(review): restore shared diff appearance and requested reading settings | pending |
| `a8f4401737` | 2026-09-17 | fix(transcript): a work group grows to fit an open member, and a running write names its file | pending |
| `6039515995` | 2026-09-17 | fix(transcript): pin the viewport to the end only while a turn streams | pending |
| `53cdd7ec69` | 2026-09-17 | fix(transcript): a fold shown on the preview stays when the full read finds less to hide | pending |
| `0d587913ec` | 2026-09-17 | fix(transcript): a cold switch folds a settled turn from its first frame | pending |
| `0414da8934` | 2026-09-17 | feat(transcript-lab): three more sessions, one of them ninety prompts long | pending |
| `c6b7e064af` | 2026-09-16 | fix(session-ui): set the tool image row in the weak text tokens | pending |
| `25d3f103db` | 2026-09-16 | fix(markdown): budget the first-frame parse; one completion branch in the turn runner | pending |
| `156e7e0ab8` | 2026-09-15 | feat(session): session rendering fixes, task images, and queued messages in the timeline | pending |
| `414e646bf8` | 2026-09-15 | Revert "fix(transcript): let a skill row open and show what the skill did" | pending |
| `05223759ce` | 2026-09-14 | test(mcp): pin the transcript's first-party roster to the registered tools | pending |
| `46d1de1859` | 2026-09-14 | fix(session-ui): let card links navigate through the router and keep a refusal whole | pending |
| `b277bda47f` | 2026-09-14 | fix(session-ui): give the question-card icon its stroke in CSS | pending |
| `b54c2e20ba` | 2026-09-13 | fix(session): give the question dock a real minimize control | pending |
| `a88d33df58` | 2026-09-12 | feat(transcript): show a shell row's non-zero exit code | pending |
| `aea08cc1b6` | 2026-09-12 | fix(transcript): decide a turn's fold before the first paint of a session switch | pending |
| `bfe65fd35b` | 2026-09-12 | fix(transcript): paint a long list whole instead of growing it after paint | pending |
| `822eade9f6` | 2026-09-12 | fix(transcript): let the virtualizer's overscan read the band the extractor uses | pending |
| `2a6bf22569` | 2026-09-12 | fix(transcript): show every tool's images, and drop the fold shape only a story used | pending |
| `c7044a8773` | 2026-09-12 | fix(workspace): scope a subagent tab to its parent, and give the chip back its anchor | pending |
| `708120f498` | 2026-09-12 | fix(review): restore the coverage and the count the invalidation rewrite dropped | pending |
| `028d333e97` | 2026-09-12 | fix(session-ui): redact the transcript-lab fixture and close the stories export | pending |
| `1eb8de89a5` | 2026-09-12 | fix(transcript): listen for transcript link opens on the timeline root | pending |
| `0c275347df` | 2026-09-12 | fix(transcript): name an unnamed work run, and other fold review findings | pending |
| `9fb9f97094` | 2026-09-12 | chore(lint): clear the fix wave's eighteen oxlint errors | pending |
| `bf675dd6c9` | 2026-09-12 | fix(transcript): carry a Claude question's answers to the question renderer | pending |
| `ec523365d4` | 2026-09-10 | fix(transcript): a turn folded by hand hides the live step too | pending |
| `9f3697fd5f` | 2026-09-10 | fix(transcript): stop an unnamed tool breaking a run of work | pending |
| `7c1a73b141` | 2026-09-10 | fix(transcript): keep a subagent's summary to one line in its card | pending |
| `ee264e605e` | 2026-09-10 | refactor(contract): canonicalise a harness tool name once, at the boundary | pending |
| `11d2858f52` | 2026-09-10 | test(e2e): hold the transcript's real contract in three stale cases | pending |
| `b0455ce247` | 2026-09-10 | fix(transcript): repair the JSX fragment that broke the app build | pending |
| `3f6ee7a048` | 2026-09-10 | fix(transcript): keep the fold control on an interrupted turn | pending |
| `1e02ffce35` | 2026-09-10 | fix(transcript): let a running tool say what it is and be opened | pending |
| `15e8437dc5` | 2026-09-10 | fix(transcript): let a skill row open and show what the skill did | pending |
| `0a88ccdc46` | 2026-09-10 | fix(transcript): render and group Claude's `ls` as a directory listing | pending |
| `90414ab72f` | 2026-09-10 | fix(transcript): keep subagent cards out of the turn fold | pending |
| `f82f026e7f` | 2026-09-10 | fix(transcript): recognise the Claude harness's subagent spawns | pending |
| `051c68d5b9` | 2026-09-09 | fix(review): unbind the changed-file row layout from the Codex theme | pending |
| `726b7e4fb8` | 2026-09-09 | fix(ui): unify icon mappings and interaction references | pending |
| `656cf95af2` | 2026-09-09 | fix(app): retire deleted sessions across desktop restart | pending |
| `566ae65441` | 2026-09-08 | fix(subagents): preserve cross-harness child ownership and presentation | pending |
| `b7ffabe91b` | 2026-09-07 | fix(session): derive the transcript peek state and hide the session title while floating | pending |
| `bc2d1671f9` | 2026-09-07 | merge: test-quality audit and @claxedo/helpers consolidation into dev | pending |
| `27ceb6bd02` | 2026-09-06 | refactor(lint): resolve oxlint type-aware violations across the monorepo | pending |
| `5e503ddc41` | 2026-09-06 | chore(lint): apply oxlint safe autofixes and scope test-file type rules | pending |
| `ffdd2577f5` | 2026-09-05 | fix(app,e2e): green dev after the embedded-SDK harness cutover | pending |
| `d98181076a` | 2026-09-02 | Merge branch 'dev' into codex/cloudflare-multiplayer-migration | pending |
| `c2a861ac82` | 2026-09-01 | fix(timeline): drop zero-height measurements that collapse the virtual size | pending |
| `992c145dee` | 2026-09-01 | fix(markdown): use the line-height token in the image fallback chip | pending |
| `b7d8071448` | 2026-09-01 | fix(markdown): stable fallback chip for images instead of broken-glyph flicker | pending |
| `1b65a9e526` | 2026-09-01 | fix(timeline): render rows eagerly instead of content-visibility skipping | pending |
| `5697502dec` | 2026-09-01 | fix(timeline): upgrade the virtualizer and stop the double/blank/gap settle bugs | pending |
| `264e32d830` | 2026-09-01 | fix(session-ui): reference definitions no longer collapse the streaming projection | pending |
| `34cca15f58` | 2026-09-01 | Merge branch 'dev': unify Goal mode with runtime hardening | pending |
| `7d6616f2c7` | 2026-08-28 | fix(multiplayer): finish origin/dev rebase glue | pending |
| `e289842f37` | 2026-08-28 | fix(session): preserve canonical central lifecycle | pending |
| `e8b3b7816e` | 2026-08-29 | fix(session): paint completed markdown rich on first fold and stop layout jumps | pending |
| `b08be5fc88` | 2026-08-28 | fix(ci): stabilize terminal timeline rows | pending |
| `1d997273b5` | 2026-08-28 | fix(ci): stabilize timeline and Windows contracts | pending |
| `7a8f1a92f6` | 2026-08-28 | fix(ci): preserve timeline control clicks | pending |
| `621d143f5c` | 2026-08-27 | fix(session): prevent stale busy errors after stop | pending |
| `5b1f8840d1` | 2026-08-27 | fix(session): recover canonical state after interrupted turns | pending |
| `fedad52254` | 2026-08-27 | Merge branch 'codex/fix-harness-model-continuation' into codex/claxedo-platform-release-hardening | pending |
| `429f980029` | 2026-08-27 | fix(session): harden harness handoff recovery | pending |
| `fa1ae4940e` | 2026-08-27 | fix(session): continue across models and harnesses | pending |
| `f13664cbad` | 2026-08-26 | fix(session): confirm deletion with the visible title | pending |
| `d7781af509` | 2026-08-26 | fix(session): unify parent navigation focus | pending |
| `919e7beaa9` | 2026-08-24 | fix(test): per-phase observers, bearer bisect, opencode budget, eventual-prune window | pending |
| `baaae8fcc1` | 2026-08-07 | fix(app): align cross-harness contracts and CI gates | pending |
| `f69bde5308` | 2026-08-07 | fix(runtime): complete cross-harness subagent integration | pending |
| `3d435aaea9` | 2026-08-07 | fix(app,runtime): render a cancelled Codex turn as interrupted | pending |
| `857f3368fa` | 2026-08-07 | feat(app,session-ui): move rail status into its own glyph column | pending |
| `8d86fd5b1f` | 2026-08-07 | fix(app): validate ambiguous inline code paths | pending |
| `5fe646cdf4` | 2026-08-06 | fix(app): keep session titles stable across surfaces | pending |
| `6e5f1a27c9` | 2026-08-06 | fix(app): open external images in workspace browser | pending |
| `8b842a19cb` | 2026-08-06 | fix(app): clarify tool and file icons | pending |
