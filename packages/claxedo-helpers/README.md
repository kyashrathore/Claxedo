# @claxedo/helpers

One owner per behaviour, for the small helpers the whole workspace keeps
rewriting.

This package exists because of a measured problem, not a stylistic preference.
As measured before this package existed, 586 helper names are defined in more
than one shipped file — 1,707 definitions producing 1,473 *distinct*
implementations. Only 62 of those names are honest copy-paste. The rest were
re-derived independently, and they disagree: of 146 helpers that narrow an
`unknown` to an object, 52 accept arrays and 94 reject them, so `record(x)`
means two different things depending on which file you are reading.

## Rules

1. **The name states the behaviour.** `isRecord` rejects arrays; `isObjectLike`
   does not. `nonEmptyString` trims; `asString` does not. Where two helpers
   differ in behaviour they get different names — never one name with a flag,
   and never one name with two implementations.
2. **Nothing lands here without call sites.** A helper moves in when at least
   two packages need it, and the sites that used to have their own copy are
   migrated in the same change. A "might be useful" utility drawer is how this
   package would become the thing it was built to prevent.
3. **Behaviour changes are audited, not assumed.** Replacing an
   array-accepting guard with a rejecting one changes what the caller does.
   Each migrated call site is checked, not batch-replaced.
4. **A name that lands here is reserved.** `script/helpers/canonical.json`
   records it, and `bun run test:architecture-ratchets` fails any package that
   defines that name locally again. Reservation is what makes consolidation
   stick — but it is recorded *with* the migration of that capability, not
   ahead of it. Reserving a name while the old copies are still on disk turns
   the gate red against every one of them.

## Layout

The root export is runtime-neutral: everything it re-exports is valid in the
browser and Electron renderer, on Node and Bun, and on workerd. Helpers that
import a `node:` builtin are reachable only through their own subpaths —
`@claxedo/helpers/fs`, `/path`, `/process`, `/net` — so importing the root
never drags a Node builtin onto a worker or renderer import graph.

## Dependencies

Zero runtime dependencies today, and a third-party one is admitted only when it
is tree-shakable and its absence would mean re-deriving real complexity here. A
shared helper that pulls in a package pushes that dependency onto every
consumer, and the packages here are consumed by published ones.
