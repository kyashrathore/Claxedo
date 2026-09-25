# Codemods

Tools that rewrite app code; they are not app code and nothing imports them.

## `rename-ids.ts`

Gives app-defined names the Claxedo spelling (`userMessageID` → `userMessageId`) through the TypeScript language service, so every reference moves with its declaration. The runtime contract's own fields (`sessionID`, `messageID`, `partID`, `providerID`, `modelID`) are left alone where they are the contract's: a key in an object literal whose contextual type is the contract's. A key of that name on an app object is renamed.

- `bun scripts/codemods/rename-ids.ts discover <file>...` prints the rename list: every app-declared name in those files that the claxedo-names check calls an OpenCode name.
- `bun scripts/codemods/rename-ids.ts apply <list.json>` renames each listed declaration and every reference, in rounds until none is left.

`rename-ids.list.json` is the list for the timeline's and transcript's remaining names, which live in `message-timeline.tsx`, `message-timeline.data.ts` and `timeline-virtualization.ts` and the files they share types with. A branch that changed those files re-runs `apply` with the same list after merging and resolves by keeping its own logic with the new names. Run `bun run typecheck` after `apply`: a name the language service cannot follow (a structural copy with no shared type) shows up as a type error.
