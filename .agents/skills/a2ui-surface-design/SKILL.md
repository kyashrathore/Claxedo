---
name: a2ui-surface-design
description: "Design and verify A2UI surfaces in this repository: an agent's ui_show reply, an app plugin's surface page, a reference spec in a test or fixture, or a change to the surface design guide or catalog. Use whenever you write or review surface components, change how the renderer draws them, or edit the guidance agents and plugin authors receive."
---

# A2UI surface design

The design guidance has one copy: `SURFACE_DESIGN_GUIDE` in
`packages/claxedo-plugin-api/src/surface/design-guide.ts`. Agents in a Claxedo
session read it through the `ui_guide` MCP tool
(`packages/claxedo-mcp/src/tools/surfaces.ts`), and the app plugin guide points
plugin authors to it. Read that file before writing a surface; the catalog it
draws on is `packages/claxedo-plugin-api/src/surface/catalog.ts`. Do not copy
its content into this skill, an AGENTS.md, a README or a tool description.

## Build

1. Start from the guide's closest recipe and keep its structure: Header,
   Sections, fields in a Grid, one primary Button.
2. Check the spec with `checkSurfaceSpec` from `@claxedo/plugin-api/surface`;
   it names each problem by JSON Pointer.
3. Run the guide's own checklist ("Before you show it") against the result.

## Verify by screenshot

A spec that passes the check can still look wrong, so look at it in the real
app through the e2e harness (`packages/claxedo-app/e2e/README.md`):

- Agent reply: copy the arrange of `e2e/flows/60-agent-surface-reply.spec.ts`,
  scripting `mcp__claxedo__ui_show` with your spec through
  `stack.scripted.scriptTool`. Plugin page: use the fixture plugin of
  `e2e/flows/61-plugin-surface-page.spec.ts`
  (`e2e/harness/fixture-plugin-surface.ts`).
- Wait for `[data-component="surface"]`, then for each of `dark` and `light`
  call `app.emulateMedia({ colorScheme })` and
  `surface.screenshot({ path: testInfo.outputPath(...) })`, as
  `e2e/flows/30-user-message-fold.spec.ts` does.
- From `packages/claxedo-app`, run
  `bun run e2e -- e2e/flows/<file> --project=web` and again with
  `--project=phone`. Screenshots land under `e2e/results/`; open them and
  compare with the guide's principles and anti-patterns.
- A preview spec made only to look is scratch work: delete it afterwards. A
  user-visible change to the renderer updates flow 60 or 61 instead.

## Change the guidance

Edit `design-guide.ts` only. Every `~~~json` block in it is a complete
`ui_show` input, and `design-guide.test.ts` checks each one against the
catalog, resolves every binding against its data, and requires every component
to be drawn, at most one primary Button and at most 7 blocks under the root.
Run `bun test src/surface` in `packages/claxedo-plugin-api` after any change to
the guide or the catalog.
