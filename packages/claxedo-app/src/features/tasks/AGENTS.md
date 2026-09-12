# Tasks Feature

The Tasks feature owns the app half of `@claxedo/tasks`: the authenticated
catalog client, its query keys and invalidation, the filter/selection/draft
state, and the composition that renders the package's presentational Solid
components.

Every rule about presets, tasks and links lives in `@claxedo/tasks`. This
feature does not re-decide validation, attempt numbering or liveness; it calls
the routes and renders what they answer. Nothing here writes a query cache
entry, so a refused command cannot leave the screen showing a change the server
did not make.

The harness/model/effort control, the installed plugin and skill catalog, the
project list and canonical session navigation arrive through `app-ports.ts`.
Their owners are other features, which a feature may not import at runtime;
`app/integrations/tasks` binds them.

```json
{
  "owns": "Tasks and presets catalog data, filter and draft state, and the app composition of the @claxedo/tasks Solid components",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/agent-plugins/*", "@/features/browser/*", "@/features/documents/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/settings/*", "@/features/terminal/*", "@/features/usage/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```
