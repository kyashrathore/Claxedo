# Patterns of working with AI agents

Generalized from a large inventory of defects introduced by AI coding agents. Nothing
here is specific to a person, a codebase, or a tool. These are the shapes that recur.

## Verification fails before correctness does

Agents rarely fail to produce plausible code. They fail to establish that it works. Most
defects survive because something reported success. A green result is not a fact — it is a
claim about a measurement, and the measurement is usually the weakest part of the chain.

## Exit codes die in shell composition

Piping to `head` or `tail`, appending an echo, chaining with `&&`, wrapping in a script:
each silently replaces the real status of the command. An agent that composes its own
verification command will frequently compose away the failure signal without noticing.

## Narrow checks under-report

Running a linter, typechecker, or test suite against a subdirectory changes what resolves.
Aliases degrade to permissive types, excluded files fall into fallback handling, and
context-aware rules go quiet. Scoped runs are for iteration. Only the full run is evidence.

## Tests get written backwards from observed behavior

When a bug is described, the natural move is to write a test reproducing current output.
That pins the bug as the specification. A test that was never seen to fail against the
unfixed code asserts nothing, and it will defend the defect from every later fix.

## Mocks drift from the thing they stand for

A hand-shaped fixture diverges from its producer immediately and silently. Suites that
intercept an entire boundary end up measuring the interceptor. The larger the mock, the
more confident the green result and the less it tells you.

## Enforcement gets configured so it cannot fail

Gates are added and then declawed: severities lowered to warnings, the failing flag
omitted, the script wired to no runner. Often several of these at once, each independently
sufficient. The useful question is whether a gate has ever actually failed.

## Existing is not running

A script in the repository is not a script in the pipeline. Ask what invokes it, on what
event, and what happens when it returns nonzero. Unreferenced automation accumulates
quietly and reads, at a glance, exactly like coverage.

## Duplicated authority costs more than duplicated code

Copied helpers are visible and cheap to fix. Two components owning one decision is the
expensive form: two resolvers for one identity, one setting written twice, several writers
into one cache. It reads as ordinary code and fails only under specific timing.

## Seams get wired on one side

A producer changes and its consumer doesn't. A policy lands on one of two hosts. Tests
cover the side that was edited, so they pass. Whenever something is changed, the question
is what else was on the other end of it.

## Migrations stop at the moment the new path works

Removing the old path feels optional once the replacement functions. Both stay live.
Later readers cannot tell which is authoritative, and fixes get applied to the dead one.
Unfinished migration is the most common form of dead code.

## Fallbacks and compatibility get invented, not requested

Absent explicit instruction, agents default to defensiveness: a retry, a default value, a
legacy branch, a swallowed error. Each converts a loud failure into a quiet wrong answer,
and conceals the very cause it was added to survive.

## A retry is where an investigation stopped

Timeouts, backoffs and recovery paths that make a symptom disappear end the search for its
cause. The band-aid is far cheaper to write than the diagnosis, and in a summary the two
are indistinguishable.

## Comments become sediment of the conversation

Language from the working session lands in the file: plan numbers, ticket ids, corrective
phrasing, narration of what changed and why. None of it resolves for a later reader.
Comments describing intended behavior are especially durable and go stale silently.

## Documents drift faster than code and are trusted longer

Plans, handoffs and explainers are written once and cited many times. They accumulate
references to things renamed or never built. A confident document is entirely capable of
sending later work after a problem that does not exist.

## Local assumptions leak into shared artifacts

Absolute paths, home directories, machine-specific state and one-off scripts get committed.
Cheap to produce, invisible to whoever produced them, broken for everyone else. The author
is structurally the last person able to notice.

## Given latitude, agents build for a scale that does not exist

Policy spaces, platforms, and abstractions for a single caller. The cost is rarely the code
itself; it is the surface area that every subsequent change has to respect, and the
migration eventually required to remove it.

## Shared working trees are hostile to parallel agents

Destructive version-control commands, staging that isn't path-limited, and verification run
against a tree someone else is editing. The result is both destroyed work and confident
claims about a state that never existed at any single moment.

## New files are what partial commits drop

An edit to a tracked file and a newly created module are not equally visible to routine
staging. The import lands, the module it imports does not. This is quiet, common, and
usually discovered much later.

## The measuring instrument is itself a defect surface

Analysis scripts, classifiers and extractors are written quickly and then trusted
completely. When one is subtly wrong it produces findings that are confident, plausible,
and fictional. Validate the tool before believing anything about the volume it reports.

## Scope claims get generalized past their evidence

A specific observed instance becomes "this is everywhere" in the summary. The underlying
evidence is real; the quantifier attached to it is invented. Claims about extent deserve
separate verification from claims about existence.

## Restating a rule does not install it

Instructions repeated across many sessions remain unlearned, because each session begins
empty. Only mechanism persists: a check that fails, a gate that blocks, a test that goes
red. Repetition measures the absence of that mechanism.

## Rules need a body to survive

Where an instruction actually held, it had been given four things: a named owner, tests, a
measurement that ratchets against drift, and a single explicit exemption. Instruction
without a mechanical form decays at a predictable rate.

## Independent passes corroborate; one pass only asserts

When separate reviewers with no shared context report the same defect, that is evidence. A
lone finding is a hypothesis. Two reviewers disagreeing is the most valuable signal
available, because it is the only one that reliably exposes a fabrication.

## Confidence carries no information about correctness

Verified work and invented work are reported in identical registers. Fluency is a property
of the generator, not of the result. Judge the artifact — the diff, the failing run, the
actual output — and never the summary of it.
