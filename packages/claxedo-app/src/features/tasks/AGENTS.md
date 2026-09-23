# Tasks Feature

The Tasks feature owns everything the user sees of `@claxedo/tasks`: the
authenticated catalog client, its query keys and invalidation, the
filter/selection/draft state, the view-model the list, board, task page and
preset editor read, and those components themselves. They are built from the
host's own primitives in `@opencode-ai/ui`, which is why they live here and not
in the kit — the kit is embeddable and carries no UI library.

Every rule about presets, tasks and links lives in `@claxedo/tasks`. This
feature does not re-decide validation, attempt numbering or liveness; it calls
the routes and renders what they answer. Nothing here writes a query cache
entry, so a refused command cannot leave the screen showing a change the server
did not make.

The harness/model/effort control, the installed plugin and skill catalog, the
project list and canonical session navigation arrive through `app-ports.ts`.
Their owners are other features, which a feature may not import at runtime;
`app/integrations/tasks` binds them.
