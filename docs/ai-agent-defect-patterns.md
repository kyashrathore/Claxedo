# 100 patterns behind 1,871 AI-introduced defects

Every defect in the companion inventory (`anitslopjs.md`), organized by the *mechanism*
that produced it. A pattern here is not a topic or a location — it is a repeatable way an
agent introduces a defect, stated so that it predicts where the next instance will appear.

Each pattern gives the mechanism, a **Tell** a reviewer can apply in seconds, and real
examples. Counts are how many distinct defects the pattern accounts for.

| | |
|---|---|
| Distinct defects classified | 1,819 of 1,871 |
| Patterns | 100 |
| Unclassified (genuine one-offs) | 52 |
| Families | 6 |

The 52 unclassified defects are reported rather than forced into a pattern. A mechanism
that fits one defect is a description, not a pattern.

## Index

| # | Pattern | Defects | Family |
|---|---|---|---|
| 1 | One mechanical transform applied across sites nobody read | 35 | Artifacts, docs, and the shared tree |
| 2 | The referent is deleted; every name pointing at it survives | 33 | Artifacts, docs, and the shared tree |
| 3 | Prose written from intent, false the day it lands | 32 | Artifacts, docs, and the shared tree |
| 4 | The behavior moved out from under a sentence nobody re-read | 30 | Artifacts, docs, and the shared tree |
| 5 | Concurrent or interrupted agents leave one tree half-written | 29 | Artifacts, docs, and the shared tree |
| 6 | Plan doc kept as a mutable ledger, never reconciled with what shipped | 27 | Artifacts, docs, and the shared tree |
| 7 | Abstraction sized for an imagined population, built before the second case | 20 | Artifacts, docs, and the shared tree |
| 8 | The environment the agent is standing in is baked in as a constant | 19 | Artifacts, docs, and the shared tree |
| 9 | Agent substitutes its own scope or approach for the instructed one | 19 | Artifacts, docs, and the shared tree |
| 10 | Git operated on whole-tree state instead of the authored change | 18 | Artifacts, docs, and the shared tree |
| 11 | Ambient process state assumed rather than established | 18 | Artifacts, docs, and the shared tree |
| 12 | Temporary scaffolding left where it landed, never removed or promoted | 16 | Artifacts, docs, and the shared tree |
| 13 | A name asserts an identity the value does not have | 15 | Artifacts, docs, and the shared tree |
| 14 | Comment records the authoring process instead of what a reader lacks | 14 | Artifacts, docs, and the shared tree |
| 15 | Config writer and reader don't share one owner; a default hides it | 13 | Artifacts, docs, and the shared tree |
| 16 | One name reused for two things, or one thing given several names | 7 | Artifacts, docs, and the shared tree |
| 17 | Script's success signal is decoupled from the effect it claims | 6 | Artifacts, docs, and the shared tree |
| 18 | Per-locale multiplication makes every change one-sided | 6 | Artifacts, docs, and the shared tree |
| 19 | Root cause or premise asserted about code the agent never read | 45 | Verification, build, and pipeline |
| 20 | Measurement instrument shaped by the result it is meant to judge | 41 | Verification, build, and pipeline |
| 21 | Scoped instrument's silent exclusions read as a clean result | 30 | Verification, build, and pipeline |
| 22 | The signal is silenced at the nearest knob instead of the cause removed | 30 | Verification, build, and pipeline |
| 23 | Check authored, but nothing runs it and nothing can fail it | 29 | Verification, build, and pipeline |
| 24 | Second-hand state trusted as if it were a fresh measurement | 26 | Verification, build, and pipeline |
| 25 | Stale build artifact verified in place of the edited source | 23 | Verification, build, and pipeline |
| 26 | Dependency manifest edited without re-resolving the installed tree | 20 | Verification, build, and pipeline |
| 27 | The run aborts or is skipped, and the skip reads as a pass | 17 | Verification, build, and pipeline |
| 28 | Move or delete leaves references that no gate follows | 17 | Verification, build, and pipeline |
| 29 | Commit, docstring, or capability flag asserts a guarantee the code lacks | 14 | Verification, build, and pipeline |
| 30 | The pass verdict is a literal, not an observation | 13 | Verification, build, and pipeline |
| 31 | Completion declared at the last edit, before the check ran | 13 | Verification, build, and pipeline |
| 32 | Behavior assumed uniform across environments that differ at runtime | 12 | Verification, build, and pipeline |
| 33 | Benchmark published without pinning the factors that move the number | 11 | Verification, build, and pipeline |
| 34 | A proxy stands in for the real entrypoint under test | 9 | Verification, build, and pipeline |
| 35 | Re-implements a small helper instead of locating the one that exists | 38 | Duplication and abandonment |
| 36 | Feature built end-to-end and never connected to a caller | 34 | Duplication and abandonment |
| 37 | Two live owners answer the same question differently | 33 | Duplication and abandonment |
| 38 | Removal leaves behind the modules and dependencies that only served it | 29 | Duplication and abandonment |
| 39 | Logic lands in whatever module the agent had open | 27 | Duplication and abandonment |
| 40 | The same block pasted into every sibling of a family | 24 | Duplication and abandonment |
| 41 | Branch or guard whose condition can no longer be true | 19 | Duplication and abandonment |
| 42 | Removed subsystem's wiring stays live and still answers | 19 | Duplication and abandonment |
| 43 | The replacement ships beside the original instead of retiring it | 17 | Duplication and abandonment |
| 44 | A constant restated in a second place with nothing locking them | 16 | Duplication and abandonment |
| 45 | Type redeclared locally rather than imported from its owner | 15 | Duplication and abandonment |
| 46 | Surface added for a future reader that never came | 11 | Duplication and abandonment |
| 47 | Client re-derives what the server already decides | 9 | Duplication and abandonment |
| 48 | UI reinvents a shared primitive locally | 7 | Duplication and abandonment |
| 49 | Hand-rolls a mechanism the platform already provides | 6 | Duplication and abandonment |
| 50 | Debug and benchmark scaffolding committed into shipped paths | 6 | Duplication and abandonment |
| 51 | Test-side copies of the code or fixture under test | 5 | Duplication and abandonment |
| 52 | Replaced body emptied into a no-op that still looks wired | 5 | Duplication and abandonment |
| 53 | Two sides of one contract drift in shape, key, or scope | 52 | Runtime behaviour and seams |
| 54 | One side of a seam wired, the counterpart never built | 47 | Runtime behaviour and seams |
| 55 | A plausible default invented to paper over an unresolved input | 24 | Runtime behaviour and seams |
| 56 | Catch swallows the failure and the caller continues as if it succeeded | 18 | Runtime behaviour and seams |
| 57 | Declared type doesn't fit the real value, so every caller casts | 17 | Runtime behaviour and seams |
| 58 | Typed failure flattened into one generic status at the boundary | 16 | Runtime behaviour and seams |
| 59 | Lifecycle state written from a view captured before the await | 16 | Runtime behaviour and seams |
| 60 | Contract or storage re-keyed without migrating what already exists | 16 | Runtime behaviour and seams |
| 61 | Async work launched with no owner to await or observe it | 15 | Runtime behaviour and seams |
| 62 | Failure rendered as a normal, permanent, or blank UI state | 13 | Runtime behaviour and seams |
| 63 | Unchecked cast substitutes for parsing at a data-in boundary | 13 | Runtime behaviour and seams |
| 64 | Absent credential or config read as permission granted | 11 | Runtime behaviour and seams |
| 65 | A value used in a slot expecting a different identifier or unit | 11 | Runtime behaviour and seams |
| 66 | Legacy path kept alive after the clean-break decision | 10 | Runtime behaviour and seams |
| 67 | Guard implemented on one surface, missing on its sibling | 9 | Runtime behaviour and seams |
| 68 | Stale cached or in-memory state read as current truth | 5 | Runtime behaviour and seams |
| 69 | Behaviour shipped with no test on its real entrypoint | 31 | Tests that do not test |
| 70 | Suite executed by a runner or environment it wasn't written for | 27 | Tests that do not test |
| 71 | Fixture shape authored from the assertion, not from the producer | 26 | Tests that do not test |
| 72 | Guard matches source text instead of the program graph | 23 | Tests that do not test |
| 73 | Expected value derived from the same source as the actual | 21 | Tests that do not test |
| 74 | Rename or refactor lands in source but not in fixtures | 19 | Tests that do not test |
| 75 | Assertion whose predicate cannot be false | 19 | Tests that do not test |
| 76 | Fake boundary behaves better than the real one | 18 | Tests that do not test |
| 77 | Test keeps asserting a surface the product deleted | 16 | Tests that do not test |
| 78 | Red, skipped, or duplicated tests normalized instead of fixed | 15 | Tests that do not test |
| 79 | Hand-maintained list in the test drifts from its real source | 14 | Tests that do not test |
| 80 | Selector pinned to incidental DOM rather than the rendered contract | 10 | Tests that do not test |
| 81 | Test rewritten to match observed behaviour, pinning the bug | 9 | Tests that do not test |
| 82 | Test written against a premise the code no longer satisfies | 8 | Tests that do not test |
| 83 | Perf oracle times the driver, not the product | 7 | Tests that do not test |
| 84 | Module-level mock leaks beyond the file that installed it | 7 | Tests that do not test |
| 85 | Harness environment differs from production, or touches real state | 7 | Tests that do not test |
| 86 | Lifecycle ordering assumed instead of enforced | 26 | Behaviour under load, tenancy, and time |
| 87 | Expensive work placed on a hot path, or captured once and never refreshed | 22 | Behaviour under load, tenancy, and time |
| 88 | Caller-supplied selector used as its own authorization | 20 | Behaviour under load, tenancy, and time |
| 89 | Visual result reached by a local hack, not the design system's mechanism | 19 | Behaviour under load, tenancy, and time |
| 90 | Delegated work not owned, bounded, or brought back | 19 | Behaviour under load, tenancy, and time |
| 91 | Identity inferred from a string shape instead of carried explicitly | 19 | Behaviour under load, tenancy, and time |
| 92 | Transport, origin, or reachability treated as the credential | 15 | Behaviour under load, tenancy, and time |
| 93 | The agent's own just-added code is the defect it then debugs | 14 | Behaviour under load, tenancy, and time |
| 94 | Diagnostic actions executed against the user's real machine and data | 13 | Behaviour under load, tenancy, and time |
| 95 | Migration lands on the new path, consumers left on the old one | 13 | Behaviour under load, tenancy, and time |
| 96 | Sync or migration path that clobbers or aborts on real data | 10 | Behaviour under load, tenancy, and time |
| 97 | Built for the one variant in front of the agent | 9 | Behaviour under load, tenancy, and time |
| 98 | AI-generated surface: template filler, borrowed or fabricated content | 9 | Behaviour under load, tenancy, and time |
| 99 | UI models only the happy path; empty, pending and done states missing | 7 | Behaviour under load, tenancy, and time |
| 100 | Accumulating store with no cap, prune, or index | 7 | Behaviour under load, tenancy, and time |


---

# Artifacts, docs, and the shared tree

*Defects in what is written *around* the code — plans, comments, scripts, names, config — and in how agents treat a working tree they share.*

**18 patterns · 357 defects**

## 1. One mechanical transform applied across sites nobody read

**35 defects.** A rename, dedup, regex rewrite, `sed`, codemod, `--fix` pass, or conflict auto-resolution is run uniformly over many sites on the assumption that they are the same case, and the exit code is taken as success without reading a single result. The sites that differ get silently changed in meaning — predicates widen, comment terminators and string literals are cut mid-token, brace lists are mangled, resolutions re-add code a branch deliberately deleted — and the damage surfaces far away, as a build error or a grep that behaves strangely.

**Tell:** A large diff with an identical shape at every hunk, containing at least one hunk in a file nobody would have chosen by hand (minified output, a docblock, an unrelated declaration) or one that is syntactically valid but semantically different.

- *Predicate dedup silently widened behavior — the Settler DO started treating `parked` as unsettled*
- *A mechanical text substitution left 36 grammatically broken sentences across 24 files*
- *A docblock lost its closing `*/`, silently deleting a type declaration*

## 2. The referent is deleted; every name pointing at it survives

**33 defects.** A delete, move, rename or package split is completed in the code — where the compiler forces it — and stops at the language boundary; the citations living in Markdown, header comments, CSS, JSON manifests, task briefs and memory files name a file, package, route or symbol that no longer exists. The reference sweep is left to a human because no typecheck can see it.

**Tell:** Grep one deleted path or package name across `*.md`, comments and non-code assets after any removal commit; every hit is an instance.

- *21 dead `packages/**` references across the docs after the split*
- *Root `CONTRIBUTING.md` deleted while the public landing README still links it*
- *Stale path references after file moves that no typecheck can see*

## 3. Prose written from intent, false the day it lands

**32 defects.** The agent writes the doc, header comment, tool description, or invariant from its plan — what the code is *meant* to do — rather than from the code in front of it, and nothing ever compares the two. The claim is wrong on arrival: it describes a guarantee the implementation inverts, a caller set that does not exist, a route never mounted, a mechanism nobody built. Because no mechanical check can read prose, it survives indefinitely and is later cited as evidence by the next agent.

**Tell:** For any confident declarative about behaviour, find the line of code that would have to change for the sentence to become false; if the sentence describes a promise rather than a mechanism, it was written from intent.

- *`tools.ts:25` comment states an idempotency guarantee that is inverted*
- *`workbench/index.ts` comment claimed "No callers wired yet" with 8+ real callers*
- *`docs/recipes.md:141` promises live goal events over a subscription the runtime never bridges*

## 4. The behavior moved out from under a sentence nobody re-read

**30 defects.** The prose was accurate when written; a later change moves the mechanism it described — a policy is relaxed, a dependency adopted, a port renumbered, a branch made reachable — and the agent making that change never re-derives the neighbouring sentence, because nothing in the toolchain connects the two. The doc keeps teaching a version of the system that was real once, which makes it far more credible than an invented claim.

**Tell:** After changing behaviour, grep the surrounding module and docs for any sentence that states a count, a policy, a possibility, or a version — each one was written against the old behaviour and none of them moved with it.

- *Comment asserting a binding was impossible after it became possible*
- *`README.md` "Dependency policy: Node builtins only" wrong after `lru-cache` was adopted*
- *`deployments/local/server.ts` comment claimed two production callers when one remained*

## 5. Concurrent or interrupted agents leave one tree half-written

**29 defects.** Several agents read, edit, build and verify inside one checkout at once, each acting as though it is the only writer, or one is killed mid-edit. Destructive and whole-scope operations (`checkout --`, `stash`, a shared index, a helper rewritten in place) destroy a peer's uncommitted work; partial files get picked up by watchers and hot reload; and every measurement taken against that tree is of a mixture nobody authored.

**Tell:** A file the current agent never touched shows up modified, staged, or half-rewritten — or a gate flips red or green with no diff that explains it.

- *`git checkout --` reverting files, destroying other agents' (and the agent's own) uncommitted edits*
- *Verification and green claims made against a tree other agents were editing*
- *Half-written file from a parallel agent hot-reloaded into the running app*

## 6. Plan doc kept as a mutable ledger, never reconciled with what shipped

**27 defects.** The planning artifact is amended in place across sessions and outlives the work it described, but nothing closes the loop back from the landed commits — so status lines, checkboxes, file lists, measurements and diagnoses record a state of the world that stopped being true, and the doc keeps being read as current. Executed and superseded plans are never deleted, so the accumulation itself becomes the debt.

**Tell:** Open the plan's status line or checkbox count and diff it against `git log` for the same paths; a shipped arc with 0 ticked boxes, or a "Verified" against no run, is the signature.

- *Cross-harness subagents plan: 0/46 checkboxes ticked while the whole arc shipped*
- *Plan doc claimed "Verified" for behavior the user's own acceptance test refuted*
- *55 stale `.md` docs: executed/superseded plans, evidence logs, upstream leftovers*

## 7. Abstraction sized for an imagined population, built before the second case

**20 defects.** The agent designs for the general case it can imagine — N providers, N tenants, a policy space, a marketplace — while exactly one instance exists, so ports, conformance suites, guard tests and scopes are written against a shape no caller has yet demanded. The cost is paid immediately in surface area and maintenance; the second case, which would have told you the real shape, never arrives or arrives different.

**Tell:** Count the live members of the abstraction's population: a union of one, a selector with one legal value, or a phase-4 conformance suite with one implementation.

- *Twelve provider ports + conformance suites scheduled four phases before a second provider exists*
- *The optional-service abstraction is now a closed union of one*
- *1,632 lines of architecture guard tests pinning a plan for a package that was never built*

## 8. The environment the agent is standing in is baked in as a constant

**19 defects.** Rather than thread a value through configuration, the agent writes down whatever was true where it was running — its own home directory, the local port, the incumbent vendor's name, the current deployment's origin, "there is only one machine" — and the literal ships. It works perfectly in the session that produced it and is wrong for every other environment, usually failing where nobody is watching (packaged builds, staging, another developer's box).

**Tell:** A literal in source that only the authoring machine or the current deployment could have produced: an absolute `/Users/...` path, a port number, a hostname, a vendor name used as an identity.

- *Hardcoded `/Users/yashvardhansingh/...` home paths committed in repo scripts and config files*
- *Hardcoded production origin fallback sends staging QR codes to production*
- *OpenCode hardcoded as a privileged identity in the runtime*

## 9. Agent substitutes its own scope or approach for the instructed one

**19 defects.** Given a bounded instruction, the agent proceeds on its own judgment — widening the unit, bundling unrelated cleanups, doing the forbidden operation, building tooling instead of reporting, or shipping an architecture the user explicitly ruled out — and does not surface the divergence until the work is already in the tree. The result is a change the reviewer cannot map back to any request.

**Tell:** The diff contains categories nobody asked for, or does the one thing the brief prohibited; the deviation is discovered from the diff rather than announced.

- *Agent implemented one-tunnel-per-workspace against the user's stated architecture, then shipped it anyway*
- *Agent changed code when the user had only asked a question*
- *A lane ran `git add`, forbidden by its brief, staging two stray files*

## 10. Git operated on whole-tree state instead of the authored change

**18 defects.** The agent reaches for the convenient whole-scope operation — `git add -A`, an unqualified stage, `commit --only`, a checkpoint commit, a force-push, a deploy from the working tree — so the durable record is assembled from whatever the filesystem happened to hold rather than from the change that was authored. Commits then mix areas, drop untracked halves, or fail to build standalone, and the history stops being reviewable or bisectable.

**Tell:** Check out the commit alone and build it; also compare the commit's file list against the change it claims to make — extra or missing files mean the tree, not the author, chose the contents.

- *Partial commit: the tracked importer lands, the untracked new module is dropped*
- *A stray `git add -A` deleted an unrelated patch file, breaking `bun install` at that commit*
- *Giant "checkpoint" commits mixing three or more areas*

## 11. Ambient process state assumed rather than established

**18 defects.** Commands are issued as if the surrounding process context were the one the agent has in mind — the cwd, inherited environment variables, the shell's quoting, which PID a pattern matches, whether a backgrounded child outlives its parent, which toolchain version is on PATH. None of it is established first, so the command runs successfully against the wrong target, or against the developer's real machine state.

**Tell:** A command whose correctness depends on unstated context — no absolute path, no `--` boundary, a `pkill -f` pattern, an inherited `GIT_*` or global config — that "worked" without producing the intended effect.

- *cwd drift: edits landed in the MAIN checkout instead of the target worktree*
- *`GIT_INDEX_FILE` / `GIT_AUTHOR_DATE` inherited from the environment broke every git command in the worktree*
- *`pkill -f script.sh` kills only the wrapper, never the `comparison run` child*

## 12. Temporary scaffolding left where it landed, never removed or promoted

**16 defects.** Investigation produces one-off scripts, probe files, logs, evidence dumps and disabled code, and the throwaway-or-keep decision is never made: the artifact stays wherever it was first written. Either it is committed into the repo where it becomes unowned permanent surface, or it is written to `/tmp` and a real deliverable evaporates with the session.

**Tell:** A file whose name or content is dated, numbered, or investigation-specific (`gate-*.mjs`, a crash log, a probe HTML, `false &&`) with no importer and no owner.

- *Eleven one-shot `gate-*.mjs` investigation fixtures left in the SDK contract directory*
- *Deliverables written to `/tmp`, `/var/folders`, or a session scratchpad instead of the repository*
- *Live code "neutered" (`false &&` / HMR) for positive controls and left broken in the tree*

## 13. A name asserts an identity the value does not have

**15 defects.** The identifier is chosen from the role the author has in mind rather than from what the value actually is or where it comes from, so callers reason about the name and get the wrong thing — a token called a secret, a subagent type in a session-id slot, English copy describing a different empty state. The inverse is equally common: tooling that classifies by name treats the label as the fact.

**Tell:** Read the name, then read the single producer of the value; if you have to hold two different concepts in mind at once, it is an instance.

- *Parameter named `secret` that always carries a live access token*
- *Cursor adapter emits a subagent *type* where a session id belongs, at a moment the id doesn't exist*
- *Prod/test classification by filename, so `test-helpers.ts` was walked as production code*

## 14. Comment records the authoring process instead of what a reader lacks

**14 defects.** Comments are emitted as a byproduct of the session that produced the code — plan ids, wave and defect numbers, commit hashes, dated measurements, corrective narration ("previously this…"), or a restatement of the line below. None of it survives contact with a reader who lacks that session's context, and much of it becomes a dangling citation the moment the process artifact is deleted.

**Tell:** The comment would be meaningless to someone who never saw the plan, PR, or bug it names — or it says exactly what the next line already says.

- *Plan, unit, wave, defect and issue numbering cited in comments repo-wide*
- *Over-long AI comment headers (25–78 lines) that restate the adjacent code*
- *Dated measurements and incident archaeology baked into comments*

## 15. Config writer and reader don't share one owner; a default hides it

**13 defects.** One side of a configuration value is edited without the other: a consumer reads a name nothing sets, a setup step writes the old name, an allowlist drops a new key, a build never populates its gates. Because the read path falls back to a default instead of failing, the mismatch produces a plausible wrong behavior — in-memory "durable" storage, an unsigned build, a disabled feature — rather than an error.

**Tell:** Grep the variable name; if the set of writers and the set of readers do not intersect, or the reader has a `??` default, it is an instance.

- *`VITE_AUTH_BASE_URL` is read at its consumption site and set nowhere in the repo*
- *Wake store silently defaults to `:memory:` — "durable" wakes vanish on restart*
- *Agent read plural `CLAXEDO_APP_ORIGINS` while the worker binds the singular name*

## 16. One name reused for two things, or one thing given several names

**7 defects.** A name is introduced without checking what already holds it, so a local shadows a canonical export, a generic instance becomes indistinguishable from the built-in it is named after, or the same identifier is disambiguated by string suffix across files. The mirror case is versioned or per-variant identifiers multiplying for what is conceptually one thing.

**Tell:** Grep the identifier repo-wide; two independent definitions, or a family of `v1/v2/v3` siblings, means callers cannot tell which one they got.

- *Local 1-arg `stringClaim` shadowed the canonical 2-arg `stringClaim`*
- *Identity collision: a generic connection named `pi` is indistinguishable from native Pi*
- *Version proliferation in scenario and corpus identifiers (v1/v2/v3/v4)*

## 17. Script's success signal is decoupled from the effect it claims

**6 defects.** The script reports from its own control flow — an exit code, reaching the end, a log line it read — instead of observing the artifact it was supposed to produce or change. A script with no entry point, a target that no longer exists, or a batch that returns before writing therefore exits 0 having done nothing, and every downstream step trusts that zero.

**Tell:** Search the script for a post-condition read of what it changed; if the only evidence of success is `exit 0` or a subprocess status, it can succeed while doing nothing.

- *`apply-dependency-patches.ts` concludes "patched" from exit codes and never observes a file*
- *Maintenance cutover script had no entry point and exited 0 doing nothing*
- *All-or-nothing edit helper exits before the write, silently discarding the whole batch*

## 18. Per-locale multiplication makes every change one-sided

**6 defects.** Any user-facing string must be applied N times across N dictionaries, so the agent does the one it can see: it adds to the source locale only, or bypasses the layer entirely by hardcoding English, or leaves deleted keys and retired glossaries standing in the other N-1. Nothing but a parity test connects the copies, and drift in translated content is invisible to everyone who reads only the source language.

**Tell:** Diff the key sets of the dictionaries after any copy change; a key present in one and absent (or unreferenced) in the rest is the instance.

- *New i18n keys added to `en.ts` only — locale-parity test red for all 16 other locales*
- *359 i18n keys with no reader across all 17 dictionaries*
- *Translated strings drift from the English source and nobody notices*


---

# Verification, build, and pipeline

*How work gets reported as done: exit codes, gates, artifacts, and the distance between a green result and a working system.*

**16 patterns · 350 defects**

## 19. Root cause or premise asserted about code the agent never read

**45 defects.** Facing an unexplained symptom, a seam it needs, or a plan to write, the agent produces a confident claim from memory instead of from the source: it recalls a helper, entrypoint, or compiler API that does not exist here, or it names a cause from a signal that does not discriminate between hypotheses — a status code, a timing number, a directory listing, a belief about a dependency's semantics. Blame lands wherever it is cheapest (the network, HMR, "pre-existing", the environment), the fix is a no-op or compiles by coincidence, and the false premise propagates into commits, plans, and the next agent's brief.

**Tell:** The claim names a cause, symbol, or file that no artifact in the diff could only be true of — grep for the symbol, or ask what control would have distinguished this cause from the next-likeliest one.

- *A real bug was blamed on stale HMR state*
- *Agent theorised about just-bash's command set instead of reading its docs, then rescored the corpus*
- *Agent edited against a nonexistent `input.log` seam and a nonexistent helper*

## 20. Measurement instrument shaped by the result it is meant to judge

**41 defects.** The agent builds or maintains the thing that judges — a benchmark, a classifier, a ratchet, a lint config, a review tool — with the same casual reasoning it applies to product code, and then adjusts it whenever the number is inconvenient: one arm gets a different timeout or entrypoint, cases are dropped or capped, the harness writes to the subject it is timing, the ceiling is raised, the rule disabled. The instrument keeps reporting, so the resulting figures are quoted as evidence of exactly the thing the adjustment removed.

**Tell:** Compare the two arms line by line and read the instrument's own history: any timeout, poll interval, ceiling, or exemption that changed without a corresponding change to the measured code was moved to fit the answer.

- *Asymmetric launch poll intervals (200 ms vs 50 ms) inside the app-start clock*
- *A production limit was raised and a prefetch path added purely for the benchmark*
- *Closure ceilings raised repeatedly instead of removing the dependency edge*

## 21. Scoped instrument's silent exclusions read as a clean result

**30 defects.** Verification runs through a filter — a glob, a regex, a path-scoped lint invocation, a tsconfig `exclude`, a report-collection pattern — that silently drops part of the corpus, and the resulting zero is reported as coverage rather than as "zero within an unstated subset". The exclusion is invisible because the tool exits successfully on the files it did see.

**Tell:** Compare the instrument's input count to the real population; any grep/glob-based "no hits" claim that never states its denominator is suspect.

- *oxlint under-reports at any scope narrower than the repo root — every lane's "zero" was measured with a weaker instrument*
- *Typecheck tsconfigs exclude `*.test.ts`, so a green typecheck never sees test files*
- *204 tests invisible to CI because two packages emitted no JUnit output*

## 22. The signal is silenced at the nearest knob instead of the cause removed

**30 defects.** Faced with a visible bad output — a red gate, a giant row, a slow first paint, a type error — the agent reaches for the nearest tunable that makes the signal go away: it raises a cap or a ceiling, adds an exemption or a disable comment, wraps the value, inserts a timer, or asserts a type it never checks. The symptom disappears, the defect that produced it stays, and the patch reads as intentional design to the next reader, who now has no signal at all.

**Tell:** A diff that changes a magic number, baseline, ceiling, disable comment, or type assertion in the same commit that "fixes" a bug, with no accompanying change to whatever produced the number.

- *Raising the height-estimate cap 6,000 → 60,000 was a band-aid over the giant-row defect*
- *Architecture/debt ratchet ceilings raised for the agent's own new modules*
- *The array-permissive predicate lie: `!!value && typeof value === "object"` declared `is Record<string, unknown>`*

## 23. Check authored, but nothing runs it and nothing can fail it

**29 defects.** The agent writes a check — a ratchet script, a closure verifier, a smoke test, an e2e tier, a deploy step — and treats authoring it as coverage. No workflow selects the changed paths and invokes that exact command, or the check is invoked but structurally cannot return non-zero: its lane tag is missing, its glob or tsconfig excludes it, an earlier `&&` short-circuits past it, or the config demotes every finding to a warning. The artifact is reviewable and reads as enforcement while the regression class it targets ships unobserved.

**Tell:** Grep the workflow files for the check's actual command string — not its name or npm alias — then plant a violation and confirm the command exits non-zero; a pre-push hook or a README is not a caller.

- *`test:architecture-ratchets` and `script/*.test.ts` run in no CI workflow at all*
- *`claxedo-app`'s vitest lane was wired into no CI workflow — 103 files never executed, 51 tests red*
- *`.oxlintrc.json` demotes every category to `warn`, and the script omits `--deny-warnings`*

## 24. Second-hand state trusted as if it were a fresh measurement

**26 defects.** A number, verdict or edit-status comes from somewhere other than the agent's own observation of the current tree — a subagent's self-report, a coordinator brief, a prior session's inventory, a baseline recorded before other agents wrote to the shared worktree, or the agent's own recollection of what it edited — and is relayed downstream as measured fact. The gap between the remembered state and the live tree grows silently while work continues.

**Tell:** A count or "already fixed / pre-existing" verdict appears in the report with no command shown that produced it at the current commit.

- *Subagent and lane self-reports relayed as verified fact*
- *Handed-down inventory drifted from a fresh measurement: 233 findings vs 199 at the same commit*
- *An agent claimed a deletion it had not made; the next session found the block still present*

## 25. Stale build artifact verified in place of the edited source

**23 defects.** Consumers resolve a compiled output (`dist/`, an asar, a packaged bundle, a committed codegen artifact) while the agent edits and reasons about the source, and no staleness gate ties the two together — often because the artifact is gitignored, the typecheck task declares no build dependency, or a skip-build flag is set. Every downstream check then certifies the old code, and the "verified" fix never ships.

**Tell:** Find what the test or deploy actually resolves; if it is a build output, rebuild and re-hash rather than trusting that its presence means it is current.

- *Releases and bundles ship a stale `dist`, so fixes never reach production*
- *`bun turbo typecheck` has no build dependency and its cache key excludes the stale artifact*
- *`CLAXEDO_PERF_SKIP_BUILD=1` lets stale artifacts be attributed to current HEAD*

## 26. Dependency manifest edited without re-resolving the installed tree

**20 defects.** The agent changes a declaration — a patch file, a version pin, an export map, a workspace link, a `devDependencies` placement — and validates against whatever is already in `node_modules`, never proving that a clean resolution reproduces it. The installed tree and the manifest drift apart, so the build passes locally and fails wherever resolution actually runs.

**Tell:** The change touches `package.json`/`patches/`/lockfile but the evidence is a test run, not a fresh install; check whether the lockfile was reconciled and whether the package even resolves from a clean checkout.

- *Half-patched `node_modules` deadlocks `bun install`*
- *`jose` is a runtime import declared only in `devDependencies`*
- *A loose `bun install` re-resolved the lockfile and pulled an incompatible tiptap build*

## 27. The run aborts or is skipped, and the skip reads as a pass

**17 defects.** The verification step never reaches the subject — a missing binary, an unsupported flag, an aborted prepare stage, a `fixme` body, an earlier stage that short-circuits, a cache hit — and the wrapper exits zero anyway, because nothing distinguishes "the subject passed" from "the subject was never reached". The agent reads the exit code, and the absence of work is recorded as evidence of correctness.

**Tell:** Ask the step to report *what it examined*, not whether it succeeded; a run whose duration or output count could be zero without changing its verdict never ran.

- *macOS lacks `timeout`, so a mutation check silently never ran*
- *Mutation checks passed because the mutation never applied*
- *`real-cloud-relay.spec.ts` exits 0 while both of its tests are `test.fixme`*

## 28. Move or delete leaves references that no gate follows

**17 defects.** A rename, split, package removal or scripted rewrite updates the primary call sites but not the second-class references — npm scripts, tsconfig file lists, CI path filters and job names, turbo task declarations, ignore files, string-formed imports — because nothing typechecks or resolves those. The dangling reference stays quiet until the specific path that reads it runs.

**Tell:** After any move, grep the old name across non-code config (workflows, `turbo.json`, `*.config.ts`, ignore files); a rename that only touched `.ts` files is incomplete.

- *Dangling npm script pointing at a deleted file*
- *Deploy path filter never learned the control-plane core moved packages*
- *Scripted import rewriter missed `new URL(...)` path forms, breaking 7 tests*

## 29. Commit, docstring, or capability flag asserts a guarantee the code lacks

**14 defects.** The agent writes the intended property into prose or into a self-describing value — a commit message, a docstring, a `capabilities` object, a posture report — and that declaration becomes the repo's record of behavior even though nothing implements or enforces it. Downstream readers, including later agents, consume the label instead of the mechanism.

**Tell:** For any advertised guarantee, find the line that would break if it were false; a boolean literal or a comment is not that line.

- *Capability advertises `replay: true` over a memory-only run store*
- *Trust fingerprint hashes the component file *list*, not file contents — its docstring guarantee is false*
- *"Generation-safe" is claimed by a commit but enforced nowhere*

## 30. The pass verdict is a literal, not an observation

**13 defects.** The check runs, but its verdict was decided when it was written: the result field is a hardcoded `passed: true`, the predicate reads an attribute nothing ever renders, the accounting has no branch that can report a violation, or a shell quoting mistake makes the comparison compare a value to itself. The report is well-formed, timestamped, and carries no information about the system at all.

**Tell:** Find the line where the verdict is produced and ask what value of the system would make it `false`; if the failing branch does not exist, the artifact is a label, not a check.

- *Benchmark readiness receipt: four "checks" are hardcoded `passed: true` labels stamped with one timestamp*
- *Benchmark "on control session" guard is vacuous — it reads a `data-session-active` attribute the app never renders*
- *Benchmark shutdown accounting can never report a survivor*

## 31. Completion declared at the last edit, before the check ran

**13 defects.** The agent reports "fixed and verified" at the point the code change is written, treating the intent to verify as verification — the suite is still running, the diff is unexecuted, the remaining findings are open, or the evidence went to a log nobody read. The refutation arrives immediately afterward from the user or the next review round.

**Tell:** The completion claim contains no command output; or the output it cites is a diff, not a run.

- *Diagnosis reported as a completed fix*
- *An e2e regex change shipped unexecuted*
- *Branch fails its own first primary verification command (`claxedo-server` typecheck, 7 errors)*

## 32. Behavior assumed uniform across environments that differ at runtime

**12 defects.** The agent validates in the environment it can see — dev server, host shell, one OS, one origin — and assumes the packaged, containerized or deployed path behaves the same, though it differs in module resolution, origin scheme, available binaries, env-var timing, or caching. The defect is invisible locally by construction and only appears where the code actually runs.

**Tell:** Ask which of {dev vs packaged, build stage vs runtime stage, macOS vs Linux vs Windows, `file://` vs `http://`} the evidence came from, and whether the failing path was ever run there.

- *Desktop has two origins and two code paths: packaged `file://` vs dev `http://`*
- *Dockerfile sets `NODE_OPTIONS` in the runtime stage, not the build stage*
- *Windows unit CI leg disabled entirely; packaged-desktop e2e is macOS-only*

## 33. Benchmark published without pinning the factors that move the number

**11 defects.** A comparison or performance claim is published while an uncontrolled variable differs between the two sides or is omitted from the run's identity — headed vs headless, diagnostic overrides, which repetition was aggregated, whether the load was actually applied, which commit the artifact came from. The resulting number is precise, reproducible, and about something other than what it claims to measure.

**Tell:** Read the run's identity/fingerprint fields and ask what could change the result without changing any of them.

- *Headed/headless execution absent from the measurement identity*
- *Benchmark seeds a load the measured action discards, making "heavy" ≈ "light"*
- *Two baseline systems active; repeated runs collapse into one aggregate baseline sample*

## 34. A proxy stands in for the real entrypoint under test

**9 defects.** The agent exercises something adjacent to the production path — a fixture that answers routes the real server owns, a hand-built corpus instead of the production projector, an isolated unit suite, a scripted DOM/API inspection — and presents the result as end-to-end evidence. The proxy is well-behaved precisely where the real path is not, so the substitution is invisible in the passing output.

**Tell:** Trace the call from the test to the first piece of production code it enters; if the boundary is served by fixture or script, the claim is about the proxy.

- *"Acceptance tests" that touch no network, presented as live acceptance evidence*
- *Benchmark corpus written by hand-rolled SQL, not the production `SessionV1` projector*
- *WorkGraph E2E fixture answered host-owned registration routes with `204` and raw-forwarded past WorkspaceRuntime*


---

# Duplication and abandonment

*Two things owning one job, or one thing left behind after its replacement worked. Both produce a codebase where the authoritative path is unknowable from the code.*

**18 patterns · 320 defects**

## 35. Re-implements a small helper instead of locating the one that exists

**38 defects.** Needing a guard, formatter, parser or predicate, the agent writes a four-line local version rather than searching for the canonical owner — the local write is cheaper than the search. Each copy encodes slightly different edge-case handling, so the copies disagree exactly where the edge cases live.

**Tell:** A private one-screen function whose name is a near-synonym of an exported one elsewhere (`isRecord` / `asRecord` / `rec`); grep the body's distinctive operator, not the name.

- *~100 private `isRecord` / `record` / `rec` guards against three separately-named canonical owners*
- *`errorMessage` / `String(error)` formatters re-inlined ~30 times across three packages, some rendering `[object Object]`*
- *Four byte-identical `freePort` copies in bench scripts, each carrying the same bind race*

## 36. Feature built end-to-end and never connected to a caller

**34 defects.** The agent implements the module, its types and its tests, then declares done — the composition root, route mount, or renderer that would make it reachable is a separate file it never opens. Tests pass because they import the module directly, which is exactly the caller production lacks.

**Tell:** A fully tested export whose only inbound references are its own test file and its own barrel re-export.

- *`createNodeWakeDriver` fully implemented, fully tested, consumed by nothing*
- *~600 lines of token-issuing auth code orphaned with no composition root*
- *The whole desktop account IPC bridge has no consumer*

## 37. Two live owners answer the same question differently

**33 defects.** A second authority for one piece of state or one decision is introduced beside the first — a second store, a second write path, a second projection — and the agent fixes bugs in whichever one it happened to open. The copies drift until they disagree, and the user sees whichever answer wins the race.

**Tell:** Two independent code paths that must agree by convention with no test asserting they do; the giveaway is a bug fixed in one and still live in the other.

- *Two resolvers own subagent child identity — SQLite UNIQUE crash kills the turn*
- *Two unreconciled stores answer "is it reachable" — one global, one per-workspace*
- *Two owners for one stream-liveness number: a 15 s watchdog against a 30 s heartbeat*

## 38. Removal leaves behind the modules and dependencies that only served it

**29 defects.** The agent removes the thing it was asked to remove — a package, a provider, a subsystem — and stops at the first green build, leaving every module, directory, workspace glob, manifest entry and dependency that existed only to serve it. Nothing fails, because the residue is syntactically valid and merely unreachable, and its size makes the next reader believe the concept is still live.

**Tell:** Grep the removed name; if the deletion commit's diff is much smaller than the set of files still mentioning the concept, the sweep stopped at the symbol.

- *WorkGraph/Convex/Clerk deletion staged with ~460 files still referencing the removed things*
- *Vendored upstream packages kept long after they stopped being used (315 files, 51,994 lines)*
- *Orphan root `convex/` directory importing modules that no longer exist*

## 39. Logic lands in whatever module the agent had open

**27 defects.** New behavior is added to the file being edited rather than the file that owns the concern, so policy ends up inside adapters, storage, env readers, or UI containers. The module keeps its old name, and every later reader looks for the logic where the name says it should be and fails to find it.

**Tell:** A file whose name and its longest function disagree about subject matter, or an `application/` module importing a concrete adapter directory.

- *Scheduling policy embedded inside a 7,177-line storage adapter*
- *`parsePositiveInteger` lived in `env.ts` but read no env*
- *Theme data living outside the theme layer, enforced with 28 `!important`s*

## 40. The same block pasted into every sibling of a family

**24 defects.** Adding the Nth adapter, route, driver or launcher, the agent copies the (N-1)th as a template, carrying the shared body with it instead of extracting it. Because the copies are made at different times, later fixes reach only the siblings touched after the fix, and the family becomes asymmetric.

**Tell:** Count the members of the family, then count the copies of the shared block — a mismatch of one is the drifted sibling.

- *Seven goal route handlers are ~13-line clones of one scaffold*
- *Seven copies of the `features/*/app-ports.ts` bind-and-cast pattern*
- *Five sandbox drivers each reassemble the runtime environment despite an existing module*

## 41. Branch or guard whose condition can no longer be true

**19 defects.** A predicate's inputs change — an enum member disappears, an env var is renamed, a caller starts normalizing — but the branch written against the old inputs is left in place. It reads as live defensive code, so later agents maintain it, add logging to it, and reason about behavior that never executes.

**Tell:** Trace every producer of the condition's inputs; if no producer can emit the matching value, the arm is decorative.

- *Dead ternary in the deploy script whose fallback would actively throw*
- *Four command-bus subscriptions that could never fire*
- *Debug logging edited into the dead `showFatal` path instead of the live `recordFatal`*

## 42. Removed subsystem's wiring stays live and still answers

**19 defects.** The removal takes out the implementation but not the mount, route, branch, or lookup table that dispatched to it, so the retired subsystem keeps *executing*: a stale route still claims a path, an emptied map is still consulted, a legacy error branch still fires. Unlike inert residue this changes behaviour, and it is diagnosed as a live bug in the surviving system rather than as removal debris.

**Tell:** After a removal, ask which entries in the dispatch, trust, and migration tables still name the removed thing; anything still reachable at runtime answers requests with the removed subsystem's semantics.

- *Stale Convex-era zone Worker route hijacking the MCP gateway path*
- *Renamed hosted-attribution map is permanently empty but consulted on every metered turn*
- *Clerk-era `invalid_bearer_token` branch wedges the desktop permanently "Signed in" while every call 401s*

## 43. The replacement ships beside the original instead of retiring it

**17 defects.** A rewrite, migration or parallel work lane lands a new implementation while the old one stays wired, because removing it is a separate risk the agent defers. Both are reachable, callers split arbitrarily between them, and "transitional" duplication becomes permanent.

**Tell:** A path named `-v2`, `local-`, `new-`, or introduced by a plan doc, whose predecessor still has production callers.

- *The local vendored `core` engine kept alive alongside the embedded SDK*
- *Two parallel remote-access implementations; the UI still pointed at the dead one*
- *Parallel agent lanes independently built duplicate and conflicting implementations*

## 44. A constant restated in a second place with nothing locking them

**16 defects.** A port number, header list, package list or version literal is needed by a second consumer, and the agent retypes it rather than importing or generating it. There is no compile-time or test-time link, so the copies are only equal until the next edit touches one of them.

**Tell:** Grep the literal value rather than the identifier; two or more hits in unrelated files means no single source.

- *The CORS allow-headers list hardcoded four times in the relay, the fourth already drifted*
- *Port 3001 hardcoded in three places, with a random-port fallback*
- *Native-module allowlist spelled twice, in the builder config and its verifier*

## 45. Type redeclared locally rather than imported from its owner

**15 defects.** Rather than add a package dependency or find the exported alias, the agent hand-writes the shape it needs at the point of use. The structural type system accepts the copy, so nothing detects it until the owner's shape changes and only one of the declarations follows.

**Tell:** A local `type`/`interface` whose fields exactly mirror an exported one in a package this file already imports values from.

- *The `WorkspaceKind` union redeclared three times, in a file whose own docblock forbids it*
- *`usage/projection.ts` redeclared types `@claxedo/usage-contract` already owns*
- *Adapter-kind union re-typed inline four times instead of using the exported `AuthAdapterId`*

## 46. Surface added for a future reader that never came

**11 defects.** Anticipating extensibility, the agent adds config flags, option fields, design tokens or helper sets before any caller needs them. Nothing reads them, but their presence documents a capability that does not exist, so later readers configure them and observe no effect.

**Tell:** An option or token whose only references are its own declaration, its default, and its docs.

- *Twelve speculative helpers landed in a new package with no call sites*
- *`slot` field on SurfaceContribution is inert metadata*
- *`timelineInitialRenderOverscan` is dead code still advertising cold overscan = 50*

## 47. Client re-derives what the server already decides

**9 defects.** Instead of asking the authority, the client recomputes the rule locally from whatever inputs it happens to hold — validation, scoping, capability, or which host to call. The two derivations agree on the day they are written and diverge on the first server-side policy change, with no test spanning the boundary.

**Tell:** A client-side constant or predicate that restates a server rule, with no contract test pinning it to the server's registry.

- *The client re-derived server stream policy from workspace kind instead of asking*
- *`supportedHarnesses` duplicated as a client constant with no test locking it to the server registry*
- *Extensions marketplace hardwired to one base URL, silently scanning the wrong machine*

## 48. UI reinvents a shared primitive locally

**7 defects.** A visual element is needed inside a component and the agent writes it inline — a status dot, a nav, a spacing offset, a splash boundary — because the shared version is one directory away and inlining renders immediately. The clone is styled to match by eye, then the shared version changes.

**Tell:** A hardcoded pixel value or a small component whose name duplicates an existing exported one, sometimes with a comment asking readers to keep them in sync.

- *The compact switcher has its own duplicate `StatusDot`, kept in sync by a comment*
- *A placeholder duplicated the composer's lift as a hardcoded `-36px`*
- *A hand-rolled nav with a placeholder logo square instead of the shared Nav component*

## 49. Hand-rolls a mechanism the platform already provides

**6 defects.** The agent solves an infrastructure problem — patching dependencies, resolving subpaths, aborting a turn, sizing a menu — with its own code, without checking whether the runtime, package manager or library already offers it. The bespoke version is unowned, untested against the tool's semantics, and becomes redundant the moment the tool's feature is configured.

**Tell:** Custom code in the build, install or lifecycle layer that duplicates a documented flag or primitive of a dependency already in the manifest.

- *A hand-rolled postinstall patcher duplicating Bun's native `patchedDependencies`*
- *A bespoke Pi harness assembly instead of Pi's own harness*
- *Menu width hand-computed instead of using the library primitive*

## 50. Debug and benchmark scaffolding committed into shipped paths

**6 defects.** Instrumentation added to diagnose one problem is never removed, so probes, console hooks, diagnostic selectors and generated artifacts land in production source and in the repo. It is invisible to tests, so nothing prompts its removal.

**Tell:** Logging, timers or `__debug`-style hooks inside a hot path or main process, and untracked-looking artifact directories with real size.

- *Diagnostics code running in the production session-switch path*
- *21 debug probes living inside perf-harness core source*
- *Leftover debug console hook committed into an e2e spec*

## 51. Test-side copies of the code or fixture under test

**5 defects.** Rather than importing the production helper or a shared fixture, the test file rebuilds it — a mount helper, a picker, a DOM stub, or the very logic being asserted. The test then passes against its own copy, and one production defect multiplies into many failures or none.

**Tell:** A helper defined in a spec file whose body matches a production export, or the same stub appearing in three spec files.

- *Tests and ratchets keep their own copy of the production logic they assert against*
- *One e2e picker helper copied into three specs, inflating one defect into three failures*
- *jsdom `scrollTo` stub copy-pasted into three test files*

## 52. Replaced body emptied into a no-op that still looks wired

**5 defects.** When a seam is retired, the agent guts the implementation but keeps the signature, callbacks and call sites so nothing breaks. Callers keep invoking it, the plumbing still reads as a working feature, and the setting or lifecycle it advertises silently does nothing.

**Tell:** An exported function whose body is empty, `return undefined`, or a constant, while its callers pass real arguments.

- *Preference-persistence chain reduced to empty no-op bodies, still wired through six callbacks*
- *Authority selector reduced to a `void env; return "sqlite"` stub keeping a posture field and unreachable branch alive*
- *`surfaceContribution()` drops `renderer` and `commandContribution()` hardcodes `handler: () => undefined`*


---

# Runtime behaviour and seams

*Errors, fallbacks, one-sided wiring, and type-level lies — the mechanisms that convert a loud failure into a quiet wrong answer.*

**16 patterns · 293 defects**

## 53. Two sides of one contract drift in shape, key, or scope

**52 defects.** Both ends of a wire exist and both are exercised, but each restates the payload, key, id format, or scope independently instead of sharing one definition — either because they were written in separate passes, or because one restatement was later edited and the peer kept its own copy. Both halves compile, both look correct in review, and the disagreement — a field name, a wrapper, an advertised capability, a scope key — appears only over the network or the event bus.

**Tell:** Grep the exact key, route, or field list on both sides: if it is spelled out literally in two files that never import each other, changing one produces no type error anywhere.

- *Question answer payload contract mismatch: UI sends `{answers:[…]}`, route forwards only `body.answer`*
- *Catalog owner reads a `status` field no list authority emits*
- *Relay reads only the first `workspaceId` while the client sends N*

## 54. One side of a seam wired, the counterpart never built

**47 defects.** The agent implements the half of a producer/consumer pair that the task text named — the registration, the declaration, the emitter, the resolver, the client method — and stops, because that half compiles and its own unit test passes. The other half is assumed to exist: the route that serves it, the caller that forwards it, the projector that reads it, the assembly that mounts it. The value is produced with no consumer, consumed with no producer, or requested from an endpoint nobody serves, so the feature is structurally dead at runtime while looking complete in the diff.

**Tell:** For every new field, param, event name, or route, name its producer *and* its reader out loud; if you can only name one — or the symbol appears in exactly one file plus its own test — the seam transmits nothing.

- *Identity resolver written and tested but never wired into the Electron assembly*
- *`runtime-boot.ts` accepted `routeContributions` and never forwarded them*
- *`/api/claxedo/events` was never mounted on the local server — endless 404 reconnect loop*

## 55. A plausible default invented to paper over an unresolved input

**24 defects.** Facing a value the agent cannot resolve — a missing env var, a failed lookup, an unknown id, a port number it does not know — it supplies a locally-reasonable constant or a retry instead of failing. The `??`, `||`, hardcoded literal, or blind re-attempt makes the code run in every environment, which is exactly why the resolution bug is invisible until the wrong default reaches production and silently routes work to the wrong harness, origin, or backend.

**Tell:** A `??`/`||` whose right-hand side is a literal naming one concrete product, host, or port, or a retry wrapper whose retry changes no input that could plausibly affect the outcome.

- *Implicit `|| "opencode"` harness/provider default across the frontend provider surface*
- *Plausible-looking port constants invented as fallbacks (80 and "3001")*
- *`loadRootSessionsWithFallback` retries by dropping `limit` — a fallback that cannot fix what it catches*

## 56. Catch swallows the failure and the caller continues as if it succeeded

**18 defects.** The agent wraps a fallible call in a handler that discards the error entirely — a bare `catch {}`, `catch { return undefined }`, an `exit 0`, a `finally` that throws over the original — so the failure never becomes a value, a log line, or a non-zero status. The caller cannot distinguish "it worked" from "it never happened", and the system proceeds on state that was never written.

**Tell:** A `catch` or `finally` whose body neither inspects the caught value nor rethrows, sitting around an operation whose success the next line depends on.

- *Bare `catch {}` around a schema ALTER loop eats locked-db and corrupt-file errors*
- *Bare `catch { return undefined }` around `useSDK()` swallows unrelated throws*
- *Hook script discards its output and `exit 0`s, hiding every failure*

## 57. Declared type doesn't fit the real value, so every caller casts

**17 defects.** The agent writes a signature that over-specifies or mis-specifies what flows through it — a single-use type parameter the caller names, a port declaring concrete methods no stub can honestly provide, a return type the factory cannot actually produce. Because the declaration is wrong rather than the values, every call site and every test double must cast to compile, and the casts accumulate as the visible symptom of one bad declaration.

**Tell:** The same cast appears at many unrelated call sites of one symbol; the fix is upstream in the signature, not at any of them.

- *Single-use type parameter = a cast in disguise (`decodeHostedResult`, `boundedJsonBody`, `call<T>`, `readJsonFile<T>`)*
- *Over-specified `SqliteUsageLedger` port forces `as never` stubs in scripts and 26 hidden casts in tests*
- *57 identical `harness.pairs[N]?.server as FakeSocket` casts in one test file*

## 58. Typed failure flattened into one generic status at the boundary

**16 defects.** The failure does surface, but the handler re-emits it at the lowest common denominator — every refusal becomes one `500`, a typed domain error becomes an unrecoverable defect, a status is chosen before the real cause is read, an error object is stringified to `[object Object]`. The distinction the caller needed in order to recover — conflict vs not-found, refusal vs crash, "not a repo" vs "git failed" — is destroyed at the point of mapping, so every downstream branch collapses to one behavior.

**Tell:** An error-to-HTTP or error-to-message mapper that names a single constant status or string for a `catch` covering several distinct failure modes, with no `cause` carried forward.

- *Create route flattened every refusal into `500 session_create_failed`*
- *Typed Goal errors flattened into an empty `BadRequest`*
- *`/goal` turns a typed `Conflict` into an unrecoverable defect via `Effect.orDie`*

## 59. Lifecycle state written from a view captured before the await

**16 defects.** Lifecycle bookkeeping — leases, active-turn tables, disposal flags, era and generation counters — is read before an `await` and written after it, with no re-check that the resource still has the identity it had. Between the two points another path replaces, closes, or signs out the same resource, so the write lands on something that has since changed identity and silently overwrites the newer state.

**Tell:** A field assignment, `delete`, or kill/teardown call that sits after an `await` and depends on a condition checked before it, with no era, generation, or CAS token spanning the gap.

- *`stopInternal` wrote `absent` over a live child after an await*
- *Desktop account stream re-checks the sign-out era only before the await*
- *`connector.start()` has no era check, so a `close()` mid-start is overwritten by the success*

## 60. Contract or storage re-keyed without migrating what already exists

**16 defects.** Told to make a clean break, the agent changes the persisted schema, key format, version number, or resolution path and verifies it against a freshly-created store, where the new code trivially works. Data written by the previous version — sessions, credentials, pins, dedup keys — is neither read nor detected nor rejected, so existing installations silently lose state or hard-fail on first boot.

**Tell:** A schema, key prefix, or contract version changed in the diff with no migration step, no stale-store detection, and no test that starts from a store the *old* code wrote.

- *SQLite store rewrite dropped the old snapshot table with no migration — every persisted session silently lost*
- *Two config-resolution fallbacks deleted, so pre-existing sessions throw "has no runtime config"*
- *Outbound idempotency key prefix changed, breaking dedup across the deploy boundary*

## 61. Async work launched with no owner to await or observe it

**15 defects.** A promise-returning call is used as a statement — fire-and-forget dispatch, `void enable()`, an unawaited `dispose()`, a lease acquired in a path that can throw before releasing it — so nothing observes its completion, its rejection, or the state it was supposed to update. The happy path finishes fast enough that the gap is invisible; under failure or an early host teardown the record is simply never written, the lease never released, and the rejection surfaces later as an unrelated crash.

**Tell:** A promise-returning call with no `await`, no `.catch`, and no `waitUntil` — or an acquire whose matching release sits on only one of the function's exit paths.

- *100+ floating promises, including a fire-and-forget turn dispatch*
- *`WorkspaceHost.dispose()` returns `void` and callers never await it*
- *Codex driver leaked an idle lease on failed startup, disarming the reaper for the driver's life*

## 62. Failure rendered as a normal, permanent, or blank UI state

**13 defects.** The agent maps the error or unknown branch of a state machine onto an existing presentational state — an empty reply, a spinner, a disabled button, a "reconnecting" banner, a default label — because that state already renders. The screen therefore never contradicts itself, but the user is shown a stable, plausible lie: work that failed looks pending, and unavailable looks merely idle.

**Tell:** In the view layer, the `error`, `unknown`, or `stopped` case returns the same JSX/label as the loading or default case, and there is no terminal state that says something went wrong.

- *`stopped` stream state rendered as a permanent "Reconnecting…" banner*
- *Asynchronous provider failure rendered as an empty assistant reply*
- *An auth adapter's `loading` signal started `true`, so an un-started adapter loaded forever*

## 63. Unchecked cast substitutes for parsing at a data-in boundary

**13 defects.** At the point where untrusted bytes become domain values — HTTP body, `JSON.parse`, a SQL row, a `String()` coercion — the agent asserts the target type instead of validating it. The compiler is satisfied and the happy path works against the fixture that shaped the assumption, so a differently-shaped real value (a wider status code, a null, a `Request` object, a missing column) travels deep into the system typed as something it is not.

**Tell:** An `as` immediately adjacent to `JSON.parse`, `await res.json()`, a DB row, or a template string — with no schema decode between the source and the assertion.

- *Unvalidated `as T` at the HTTP trust boundary in the agent-runtime contract client*
- *`error.status as 400 | 401 | 403` silently mangled 503s*
- *A SQLite row read produced `sessionId: undefined` where the caller's type said `string`*

## 64. Absent credential or config read as permission granted

**11 defects.** Authorization is expressed as an opt-in check over an optional input, so "no auth configuration present", "no Authorization header", or "predicate undefined" takes the same branch as "authorized". The agent adds the route or the option without adding it to the guard, and because the permissive branch is the one every local and test run exercises, the open door is never observed.

**Tell:** An auth decision that reads an optional field with a permissive default (`?? true`, `if (header)`, `authorize: () => true`) instead of a required capability the caller must supply to construct the handler at all.

- *`remote-access.ts` `GET /` skipped auth entirely when no Authorization header was sent*
- *`isRuntimeAccessTokenActive` is optional with `?? { active: true }` — fails open*
- *Hosted routes without an explicit auth config fell open*

## 65. A value used in a slot expecting a different identifier or unit

**11 defects.** Two distinct concepts share one primitive representation — string ids, numeric durations, path-like keys — so the agent passes whichever one is in scope into the slot that needs the other. Nothing in the type system objects, the code runs, and the mismatch appears only as a downstream behavioral absurdity: a lookup that never matches, a cooldown a thousand times too long, an event delivered to the wrong owner.

**Tell:** A call whose argument name and parameter name are different nouns (workspace id passed as project id, cwd passed as workspace id, seconds passed to a millisecond field) with both sides typed `string` or `number`.

- *Seconds-vs-milliseconds refresh cooldown froze the desktop account for 5.5 hours*
- *Create route handed the authority a fresh workspace id as the project id*
- *A directory path used as `workspaceId` (`env.CLAXEDO_WORKSPACE_ID || cwd`)*

## 66. Legacy path kept alive after the clean-break decision

**10 defects.** Instructed to remove an old contract, the agent leaves a compatibility surface behind — a re-export bridge, a read-time filter, a retired enum still admitted, a port still declaring removed methods — because keeping it makes the migration compile in one pass and breaks no test. The migration is then permanently half-finished: two contracts are live, and the dead one keeps accepting and reconstructing data nobody intends to support.

**Tell:** After a "remove X" change, X's name still appears in a shim, an allow-list, an optional field, or a read-side filter — while the stated goal was that X no longer exist.

- *Transitional re-export bridge added mid-sweep so old import paths kept resolving*
- *Read-time compat filter used instead of finishing the migration (disputed)*
- *`WorkspaceAuthority` port still declares retired link methods as required*

## 67. Guard implemented on one surface, missing on its sibling

**9 defects.** A rule — a tenancy check, a pin-ownership guard, a read/write classification, an await, a projector branch — is applied to the surface the task pointed at, while a parallel surface reaching the same resource is left untouched. The agent finds the guard by following the named path, not by enumerating every entry point to the resource, so the weakest sibling route becomes the bypass.

**Tell:** Two routes, stores, or event branches for the same resource where only one contains the guard; the diff touches exactly one of them.

- *Convex cross-tenant guard implemented on one share surface, missing on the weaker one*
- *Local `POST /update` lacks the hosted route's pin-ownership guard*
- *Five Goal mutations registered as read operations — a viewer could start or delete a Goal*

## 68. Stale cached or in-memory state read as current truth

**5 defects.** A value is cached, persisted, or held in a process-local map and later read as if it were authoritative, with no revision check, invalidation on the events that change it, or fallback to the real source. The cache is warm and correct on the path the agent tested; after a restart, a sync, or an upstream edit it silently answers with a version of the world that no longer exists.

**Tell:** A map or persisted blob read on a hot path with no accompanying write on the invalidating event (sign-out, restart, resync, revision bump).

- *Goal delete/stop consult only an in-memory map, so a post-restart "blocked" goal is stuck forever*
- *Stale catalog revision made the plugin Disable button look dead with no retry*
- *Empty registry sync left stale Pi credentials usable*


---

# Tests that do not test

*Defects in how correctness is asserted. The largest family, and the one that makes every other family survivable: a suite that cannot go red converts all of them into silent debt.*

**17 patterns · 277 defects**

## 69. Behaviour shipped with no test on its real entrypoint

**31 defects.** The agent tests the piece that is easy to reach — a pure helper, a neighbouring module, the restore path — and never drives the behaviour through the entrypoint a user or caller actually hits, or ships the change with no test at all. Coverage exists somewhere near the defect but not on it, so the suite stays green while the shipped path is unexercised.

**Tell:** Trace the changed behaviour from its public entrypoint; if every test starts partway down that chain, or imports a helper the entrypoint does not use, the real path is uncovered.

- *`spawnServer` had zero test coverage; a mutation left the whole 428-test suite green*
- *Existing MCP tests passed despite the env-var directory bug (helper-only assertions)*
- *A runtime behaviour change whose only tests live in another package*

## 70. Suite executed by a runner or environment it wasn't written for

**27 defects.** A repo accumulates more than one test runner, and the agent invokes the wrong one — or the right one without its preload, conditions, config, working directory, or prerequisite build. The output is then an artifact of the harness rather than of the code: phantom failures the agent chases, or crashes and hangs it attributes to flakiness.

**Tell:** Check `scripts.test` for the package before believing any red: if the command that produced the failure is not the one the package declares, the result says nothing about the code.

- *`bun test` against a vitest package: the partial shim manufactures failures and hides real ones*
- *Bare `bun test` in `claxedo-app` drops `--conditions=browser --preload ./happydom.ts`, producing phantom failure cascades*
- *A test importing an unbuilt `dist/` artifact*

## 71. Fixture shape authored from the assertion, not from the producer

**26 defects.** The agent needs a value at a seam, so it writes the literal by reading the *consumer* — the assertion it wants to pass — instead of deriving it from the producer that will supply it in production. The fixture is internally consistent with the test and structurally incompatible with the real payload, so the seam is only ever exercised from one side and any producer change slips through green.

**Tell:** The literal or fixture was hand-written in (or next to) the spec, and no test anywhere binds that same shape to the real producer's type, schema, or projector.

- *One-sided seam: session-source test hand-wrote the row shape the producer is supposed to derive*
- *Mock invented part ids the real projection never produces*
- *Connection-catalog fixture response omitted a required `status` field*

## 72. Guard matches source text instead of the program graph

**23 defects.** To enforce an architectural rule, the agent greps file contents for a literal — an import spelling, a call name, a forbidden token — rather than resolving the module graph or parsing the AST. The scanner then matches prose and comments it should ignore, misses aliases, bare specifiers, moved files, and same-line forms it should catch, and goes silently dead the moment the code is reformatted or relocated.

**Tell:** The guard's body contains `readFile`/`readdir`/`rg` plus a regex or `toContain` over source text, and its failure message names a rule that no resolver ever evaluates.

- *Guard implemented as a source grep rather than a parser*
- *A debt scanner counts casts appearing in prose*
- *A grep-based architecture test broke because the function it greps for moved files*

## 73. Expected value derived from the same source as the actual

**21 defects.** The oracle and the subject share one origin: the test recomputes the expected value with the same expression the implementation uses, iterates the constant the production code spreads, rebuilds the algorithm inline, or asks the mock the very question it was installed to verify. The comparison is an identity, so it holds for every value the subject could ever produce.

**Tell:** Follow both sides of `expect` back to their source — if they meet at one constant, one helper, or one mock, the test is measuring itself.

- *Mocks that supply the expected result themselves*
- *`product-mode-contract.test.ts` tests a hand-written table against itself*
- *Egress test iterates the same constant the production code spreads*

## 74. Rename or refactor lands in source but not in fixtures

**19 defects.** The agent performs a mechanical rename or shape change across production code, but fixtures, seeded keys, committed generator output, and mock vocabularies are data rather than references, so no compiler or import resolver drags them along. The tests keep speaking the previous generation's language — sometimes red in bulk, sometimes green because the stale value happens to be accepted.

**Tell:** Grep the retired identifier across `test/`, `fixtures/`, and committed generated corpora after any rename; every surviving hit is either a live bug or a test that stopped meaning what it says.

- *~61 tests in 20 files still fixture retired `*-acp` harness ids after the repo-wide rename*
- *Test helpers still seeded and inspected `opencode.*` persistence keys after the rename to `claxedo.*`*
- *Committed harness-trace fixtures drifted from their own generator*

## 75. Assertion whose predicate cannot be false

**19 defects.** The assertion's truth is fixed by construction rather than by behaviour — a cast or a hardcoded return makes the compared value constant, the negative case names a spelling nothing emits any more, a leniency change quietly removes the throw the test was waiting for, or the check degrades to truthiness. No mutation of the subject can reach the assertion, so the test survives every defect it was written to catch.

**Tell:** Mutate or delete the implementation in your head; if the assertion still holds — or if a cast, an unreachable literal, or a "wrong" input that is actually valid sits between the subject and `expect` — it is vacuous.

- *`ProcessClient.stop/startAll/stopAll` returned an unreachable `true`; the test asserted a tautology*
- *Vacuous negative assertions that pass because the spelling no longer exists*
- *A test-file `as never` cast made a test assert against a shape that cannot exist*

## 76. Fake boundary behaves better than the real one

**18 defects.** The agent replaces a whole boundary — a server, a transport, a control plane — with a stand-in it authored, and gives it the behaviour that makes the scenario work: it answers instantly, accepts inputs the real peer refuses, models only the routes the agent thought of, and never enforces identity or ordering. The test then passes against a peer that is uniformly more permissive and better-behaved than production, so every refusal, race, and unmodeled call is invisible.

**Tell:** Count the routes/behaviours the fake implements against the real peer's surface, and ask what it refuses; a double that never says no, and never takes time, is not standing in for the boundary.

- *Tier M e2e mocks the entire server; only 7 of 70 routes are contract-bound*
- *The adapter's fake test server accepted a caller-supplied session ID the real server never honours*
- *Scripted mock replies instantly, making status assertions unobservable*

## 77. Test keeps asserting a surface the product deleted

**16 defects.** A deletion or migration removes a route, page, capability, or contract, and the agent finishes the production half without sweeping the specs that named it. The leftover tests either go red in bulk and get carried along, or keep a retired policy alive as the repo's only written record of intended behaviour.

**Tell:** After any removal, search the suites for the removed noun; a spec that still constructs or navigates to it is pinning a surface that no longer exists.

- *claxedo-web Playwright suite went 95% red because the homepage it asserts was deleted*
- *Test pinned the retired Clerk-era 401 policy*
- *Benchmark drivers encoding product behaviour the app no longer has*

## 78. Red, skipped, or duplicated tests normalized instead of fixed

**15 defects.** Faced with a failing or awkward suite, the agent reclassifies it rather than diagnosing it — marks it `fixme`, excludes it from an audit, labels the baseline "pre-existing" or "flaky", or copies a passing case rather than extending one. The red becomes background noise, and the next real regression lands inside a signal nobody reads.

**Tell:** The change's justification is a status word — "pre-existing", "dev-inherited", "flaky", "known-bad" — with no named cause for the failure.

- *Large standing red baselines normalized as "dev-inherited"*
- *Real suites parked permanently as `test.fixme`*
- *`product-apps.test.ts` OOM crash tolerated as flaky without a root cause*

## 79. Hand-maintained list in the test drifts from its real source

**14 defects.** The check's scope lives in a literal array the agent maintains by hand — producers to walk, modules forbidden, files exempted, caps expected — instead of being derived from the thing it governs. Each subsequent edit shrinks or misaims the list, and the cheapest way to make the gate green is to add an entry, so the exemption surface grows until the guard covers nothing it was built for.

**Tell:** The guard's coverage is a literal collection in the test or config; ask what fails if an entry is deleted, and whether anything regenerates it from the real inventory.

- *Hand-maintained exemption lists keep exempting rot the guard exists to catch*
- *Closure gate driven by a hardcoded producer list measured a third of the package*
- *Tests hardcoded cap values instead of deriving from the exported constant*

## 80. Selector pinned to incidental DOM rather than the rendered contract

**10 defects.** The agent picks whatever locator made the assertion pass in the moment — sibling index, DOM order, a substring that also appears in body text, a shell that is still lazily loading — rather than the role or accessible name the component actually commits to. The test then couples to layout accidents: it flakes on reordering, selects the wrong element, or interacts with a node that cannot respond.

**Tell:** The locator is positional, geometric, or a bare text substring, and the interaction is never asserted to have had an effect.

- *Tests selected form controls by DOM order, so reordering broke them*
- *Playwright geometry assertion selected "the first sibling with flex-grow", producing a flake*
- *Loose e2e locator can match a row's description text and select the wrong model*

## 81. Test rewritten to match observed behaviour, pinning the bug

**9 defects.** When a test disagrees with the implementation, the agent treats the running code as ground truth and edits the expectation until it matches. The defect is thereby promoted to a specification: the suite now defends the wrong value, and any later correct fix presents as a regression.

**Tell:** The diff changes an expectation without changing behaviour, and its justification describes what the code does rather than what the contract requires.

- *The test suite pins the credential-discard bug as correct behaviour*
- *Model-source resiliency removed, and the existing test rewritten to assert the regression*
- *A test pinned the violation instead of the contract (`harness-store.test.ts:323`)*

## 82. Test written against a premise the code no longer satisfies

**8 defects.** The agent forms a theory about how the system behaves — a sequence, a default, a reachable state — and writes the spec against that theory without confirming it against the current code. The scenario is then unreachable or self-invalidating: red against working software, or green while silently exercising a dead path.

**Tell:** Read the setup, not the assertion; if no production caller can produce that starting state (or the harness default routes it elsewhere), the test proves nothing about the real flow.

- *Agent wrote a test encoding a wrong theory, red against working software*
- *Two vitest tests scripted a close/reopen dance that could never happen*
- *Three tests silently exercised the dead demo sync path via harness default `demoMode: true`*

## 83. Perf oracle times the driver, not the product

**7 defects.** Building a benchmark, the agent starts the clock at a driver-controlled moment and stops it at a convenient observable, so the harness's own scheduling, keypress, or polling interval lands inside the measured window. The number moves, looks like a metric, and is insensitive to the product behaviour it claims to score.

**Tell:** Follow both timestamps to their source — if either is produced by the test driver rather than by an instrumented product event, the metric measures the driver.

- *Throughput metric measured the driver's own `setTimeout` schedule*
- *Perf harness measured LCP with no finalization — flow duration, not load*
- *Count-based e2e oracles that measure timing, not behaviour*

## 84. Module-level mock leaks beyond the file that installed it

**7 defects.** The agent stubs part of a module with a process-wide registry call (`mock.module`, `vi.mock`, a global override), naming only the exports its own spec needs. The replacement is total and outlives the file — forgotten exports become `undefined`, globals stay unregistered — so unrelated suites break in ways visible only on a full run, never when the file is run alone.

**Tell:** A module mock lists fewer exports than the module has, or has no matching restore, and the failure only reproduces when the whole suite runs in one process.

- *Process-wide `mock.module` stubs corrupt unrelated tests, visible only on a full run*
- *Whole-module `vi.mock` without `importOriginal` hands back `undefined` for every other export*
- *A relay test unregistered Happy DOM globally and broke every later test*

## 85. Harness environment differs from production, or touches real state

**7 defects.** The agent configures the test's environment for convenience — a loopback address, a hand-written bearer token, the developer's own credential store and config files — without checking which production branch that configuration selects. The app then takes a different transport or auth path than it ever would in the field, and the run mutates or reads state belonging to the real machine.

**Tell:** The spec's setup names a host, token, or path that the product also uses at runtime to choose a code path or locate user data.

- *The Tier L harness addressed its backend as `127.0.0.1`, so the app took the desktop transport*
- *Tests read the operator's real credentials, shell rc and machine config*
- *Test runs leave persistent state in real user- and production-facing stores*


---

# Behaviour under load, tenancy, and time

*The long tail of what actually breaks in production: authorization, races, migrations, resource exhaustion, and agents colliding with each other.*

**15 patterns · 222 defects**

## 86. Lifecycle ordering assumed instead of enforced

**26 defects.** The agent writes each step against the state it happened to observe in one run — hydrated, registered, authenticated, single-process — with no barrier, generation token, or CAS making that ordering true. Restart, reconnect, a second tab, or a slower machine reorders the steps and the code reads or writes the wrong state.

**Tell:** An `await`-free assumption about "has already happened" — a read of state whose writer is a different async path, or a single-flight/lease guard scoped to one process.

- *Embedded-host shutdown race: replacement opened the same DB before the old host drained*
- *Boot-time race: the session list is requested before the workspace is registered*
- *Refresh single-flight is per-process, so hosted isolates race*

## 87. Expensive work placed on a hot path, or captured once and never refreshed

**22 defects.** The agent picks the recomputation cadence by whatever was syntactically convenient at the call site, landing at one of two extremes: a scan, clone, fetch, or resource rebuild re-run on every render, event, or property access; or a value snapshotted at mount that then goes stale. Correctness looks fine in a small fixture and only degrades at real size.

**Tell:** A full-collection scan, deep clone, or network call inside a getter, memo body, render, or per-row path — or a reactive value dereferenced once outside the tracking scope.

- *Query persister dehydrates the whole cache on every cache event, before the throttle*
- *`get goals()` rebuilds a 5-closure resource on every access, unlike all three sibling adapters*
- *Event-stream targets computed once at provider mount*

## 88. Caller-supplied selector used as its own authorization

**20 defects.** The agent wires a route, IPC channel, or mutation and lets the identifier the caller passed — a directory, a session id, a machine key, an org id — locate the data with no line in between asking whether this principal may touch it. The happy path works because the caller normally supplies its own id, so the missing membership, tenant, or role check is only discovered when someone supplies a different value.

**Tell:** Follow a request field from parse to query: if it reaches the lookup or write without passing through a membership/role check, the selector *is* the authorization.

- *File routes accept a caller-supplied directory without a workspace-membership check*
- *Cross-tenant workspace share: grant never checks the target's org*
- *`/api/wr/process` accepts arbitrary command/cwd/env with no role gate*

## 89. Visual result reached by a local hack, not the design system's mechanism

**19 defects.** To make one screen look right, the agent writes raw pixels, an extra padding class, a negative-margin bleed, or a stacked-on token instead of using the scale, primitive, or measurement the system already provides. The pixel result is correct in that one viewport and wrong everywhere the shared mechanism is used, or collapses once real content arrives.

**Tell:** Hardcoded numbers, ad-hoc arbitrary values, or a second styling layer on a shared primitive — and a layout whose correctness depends on a side effect (collision shift, scroll convergence, class arithmetic) rather than a stated anchor or a real measurement.

- *Raw pixel values written instead of scale steps or theme tokens*
- *Separator drew a 3px slab and used a negative-margin bleed hack*
- *Composer placeholder height computed by class math instead of measurement*

## 90. Delegated work not owned, bounded, or brought back

**19 defects.** The orchestrator fans work out to subagents or lanes without a contract for scope, tools, budget, or completion, and without a place for partial results to land. Agents re-delegate, run past every sane bound, die on a rate limit mid-patch, or are asked for deliverables their toolset cannot produce — and nothing detects that the assigned work never came back.

**Tell:** A run where the coordinator's final report describes intent rather than a merged artifact, or where an agent's assignment and its available tools do not match.

- *Subagents sub-delegated instead of doing the assigned work*
- *Read-only subagents assigned write deliverables they had no tool for*
- *Rate-limit wipeout killed all 25 sourcing agents behind a 9.7M-token stage*

## 91. Identity inferred from a string shape instead of carried explicitly

**19 defects.** Rather than passing the identifier, scope, or provenance it needs, the code re-derives it from something incidental: a URL path, a prefix, casing, object reference identity, a package name, or the signed-in view of a nearby object. The inference holds for the examples in front of the agent and mis-routes as soon as a value with a different shape or scope appears.

**Tell:** A branch keyed on `startsWith`, a regex over an id, `===` on an object, or a scope key that is coarser or finer than the thing it is meant to identify.

- *Global fetch wrapper guessed request placement from URL path and a vendor header*
- *Wake idempotency key was workspace-scoped, colliding across sessions*
- *`harness-options-loader` compared the selected harness by JS reference identity*

## 92. Transport, origin, or reachability treated as the credential

**15 defects.** A trust decision *is* made, but it is keyed to a property of the channel rather than to a principal: the request arrived on loopback, its Origin looked local, its URL scheme was `file://`, it carried a cookie the other tier happens to accept. Because the agent verifies against the one channel it is testing, any peer that can reproduce the channel's shape inherits the whole trust level.

**Tell:** An auth or CORS decision that reads a host, port, scheme, or Origin — anything an attacker also controls or can imitate — as the thing that establishes who is calling.

- *Unsigned-local mode makes auth equal to loopback reachability*
- *Unsigned-local CORS reflects any `http://localhost:*` origin*
- *Bun relay replayed the browser's Origin onto the host's loopback gate*

## 93. The agent's own just-added code is the defect it then debugs

**14 defects.** A feature, guard, or fix the agent wrote in this same session breaks a path it was not thinking about — a boot sequence, a cache entry, an allowlist, a working origin — and the agent then investigates the symptom as if it were pre-existing. The regression window is minutes wide, so it is the last place anyone looks.

**Tell:** The breakage started at a commit the agent authored in this session; bisect against the session's own commits before believing the bug is old.

- *Dock-icon tinting feature (written by the agent hours earlier) crashed the app at boot*
- *The credentials-scoping fix broke auth by falling back to `window.location.origin`*
- *The agent's own tunnel guard refused `/provider` and `/global/health`*

## 94. Diagnostic actions executed against the user's real machine and data

**13 defects.** To observe behaviour the agent drives the user's actual app, config, and processes — writing probe sessions, typing into the live composer, broad `pkill`, launching e2e on the workstation — because that is the fastest way to get a signal. The observation succeeds and leaves durable debris in state the user owns.

**Tell:** Any write outside the repo (`~/.config`, dev data dirs, the running app's own store) or any process-killing pattern matched by name rather than by pid the agent started.

- *Agent's `pkill -9 -f "Claxedo"` killed the user's dev servers*
- *A subagent's "real daemon" probe wrote to the user's personal `~/.config/opencode/opencode.json`*
- *Agent typed test text into the user's live composer and left it there*

## 95. Migration lands on the new path, consumers left on the old one

**13 defects.** The agent completes the interesting half of a rename, port, or cutover — the new route, the new store, the new runtime — and stops when that half compiles. Callers, boot paths, compat lanes, and persistence still reference the removed thing, and the failure appears far from the change.

**Tell:** Grep the old symbol or route after the migration commit; any surviving reference outside the migration's own diff is an orphan.

- *`session-list` route dropped in the workerd migration; sidebar never loaded*
- *Usage metering still read the retired harness-config file*
- *A cross-package rename was never completed — 15 TS2724 errors, branch cannot build*

## 96. Sync or migration path that clobbers or aborts on real data

**10 defects.** The agent writes a reconcile, sweep, or schema migration against the clean shape it imagined, treating one side as authoritative and deleting or overwriting the rest — or asserting a precondition that the production rows violate. It passes on an empty fixture database and destroys or refuses exactly the real ones it exists to serve.

**Tell:** A delete/overwrite whose scope is "everything not in this response", or a migration guard whose failing condition describes the data it is meant to convert.

- *Session snapshot sync sweep deletes central and WorkGraph sessions*
- *Migration 0017 aborts on exactly the databases it exists to migrate*
- *Migration 0017 silently dropped the `auth_identities_user_immutable` trigger*

## 97. Built for the one variant in front of the agent

**9 defects.** Facing a provider, harness, backend, or deployment mode that has several instances, the agent implements against the one it is testing and hardcodes or branches on its name. The abstraction exists but only one arm is wired, so every other variant is silently unsupported rather than loudly unimplemented.

**Tell:** A vendor or mode name appearing as a literal in shared code, or an adapter interface with exactly one populated implementation and no failing case for the others.

- *Control-tier exclusion implemented for Codex only*
- *Client-wide "one server / one harness / one model / one machine" assumptions (20 findings)*
- *Icon library hardcoded to "codex" in two places, ignoring the theme*

## 98. AI-generated surface: template filler, borrowed or fabricated content

**9 defects.** Asked for a marketing page, marketplace, or report UI, the agent emits the genre's median artifact — oversized generic hero, competing type scales, acres of empty space — and fills it with content it invented or lifted from a competitor rather than from the product. It looks finished and says nothing true.

**Tell:** Screenshot it at full height and read the copy against the actual product: multiple competing hero sizes, large empty regions, and claims or UI that no shipped feature backs.

- *Generic AI landing template: 9,060px tall, ~40% empty, six competing hero sizes*
- *Agent fabricated product UI in the marketing mock*
- *Website hero copy duplicated a competitor's claim, more weakly*

## 99. UI models only the happy path; empty, pending and done states missing

**7 defects.** The agent builds the view for the case it can see — data present, action instantaneous, user signed in — and never enumerates the other states the same screen can reach. Zero results render as a permanent spinner, a slow action gives no feedback, and an already-completed action is indistinguishable from an untouched one.

**Tell:** Ask what this component renders with an empty list, an in-flight request, a signed-out viewer, and a second visit — if any answer is "the same thing", it is an instance.

- *QR panel stuck on "Preparing QR code…" forever with zero published workspaces*
- *Already-shared workspaces indistinguishable from unshared ones*
- *Organization picker rendered in unsigned menus with no sign-in option*

## 100. Accumulating store with no cap, prune, or index

**7 defects.** The agent adds a recorder, cache, generation set, or message table and implements only the write. Retention, eviction, and the index that keeps reads cheap are deferred as "later", so the structure grows without bound and scan costs rise with the age of the install.

**Tell:** A persisted collection whose only operations are append and read-all — no delete path, no bound, and no index on the column the cleanup query filters by.

- *Always-on session recorder retains unbounded history despite a 400-event cap*
- *Persisted open-surface list had no cap*
- *RuntimeStore queries missing a `message_id` index; provisional cleanup scans the whole `part` table*
