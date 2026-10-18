export const SURFACE_DESIGN_GUIDE = `# Designing Claxedo surfaces

A surface is A2UI v0.9 that the Claxedo app draws with its own components: an agent's \`ui_show\` reply in the transcript, or an app plugin's surface page. The renderer already sets spacing, type scale, borders, button widths and light and dark colours. Your job is structure, wording and interaction. Every recipe below is a complete \`ui_show\` input that passes the check; a plugin sends the same \`components\` in \`updateComponents\` and the same \`data\` in \`updateDataModel\`.

## Principles

- One primary action per view: exactly one \`primary\` Button. The rest are \`default\`, or \`borderless\` for low-stakes ones (Details, Cancel).
- Hierarchy is Header → Section → content. A view opens with one Header, or with one Callout for a short agent result. Each group of related content is a titled Section. Never fake headings with Text h1/h2 in a Column.
- Group related fields in one Section and lay them out with a Grid, so the form reads left to right, top to bottom.
- Say state in words: a status is a Badge with a word ("Failing", "Merged") and a tone; an outcome or warning is a Callout. Never colour or an Icon alone.
- An empty collection is an EmptyState that says what to do next ("No deploy targets yet" / "Add one to ship from this workspace."), never a blank area.
- Progressive disclosure: secondary detail (logs, raw payloads, history) goes in a Collapsible, parallel views of the same thing in Tabs. The first screen answers the person's question.
- Never a wall of inputs. Past about six inputs, split into Sections; past three Sections of settings, use Tabs.
- Numbers carry units. A Stat value is formatted text ("412 ms", "1.28 M", "18,407"). A Table cell holds a JSON number so it right-aligns, with the unit in the column title ("p95 (ms)").
- Button labels are verbs naming the outcome: "Save changes", "Approve release", "Retry 3 failed jobs". Never "OK", "Submit" or "Yes". A destructive verb names its object: "Delete target".
- Titles in sentence case, under about 40 characters. Labels are nouns ("Region", not "Choose the region:"). Real words and data, never placeholders.
- Keep an agent reply small: one Header or Callout, at most three Sections, under about 40 components. A larger tool is a plugin page.

## Choosing a component

| To show | Use |
| --- | --- |
| A page or panel title with its status and actions | \`Header\` (\`badges\`, \`actions\`) |
| A group of related content | \`Section\`: \`card\` by default, \`plain\` for a group inside a card or a pane |
| Key figures | \`Stat\` tiles in a \`Grid\` of 2–4 columns |
| One record's fields | \`KeyValue\` |
| Many records with comparable columns | \`Table\` |
| Entities to scan, pick or act on | \`List\` with a \`ListItem\` template |
| A status word | \`Badge\` with \`variant\` neutral, accent, success, warning or danger |
| An outcome, warning, refusal or validation error | \`Callout\` with a \`tone\` |
| Prose with links or inline code | \`Markdown\` |
| Work in progress | \`Progress\` or \`Spinner\`, each with a \`label\` |
| Nothing to show yet | \`EmptyState\` |

A Badge's \`variant\` may be bound, so a template row can carry its own tone: put the tone beside the status word in each item (\`{"status": "Failed", "tone": "danger"}\`) and bind both (\`"text": {"path": "status"}, "variant": {"path": "tone"}\`); an unknown tone draws neutral. The text still says the state, so colour is never the only signal.

## Recipes

### Dashboard: Header, a Grid of Stats, then Sections

~~~json
{
  "title": "Checkout service health",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "kpis", "errors", "deploys"]},
    {"id": "header", "component": "Header", "title": "Checkout service", "subtitle": "Production · last 24 hours", "icon": "shoppingCart", "badges": ["health"], "actions": ["refresh"]},
    {"id": "health", "component": "Badge", "text": "Degraded", "variant": "warning"},
    {"id": "refresh", "component": "Button", "icon": "refresh", "child": "refresh-label", "action": {"event": {"name": "refreshCheckoutHealth"}}},
    {"id": "refresh-label", "component": "Text", "text": "Refresh"},
    {"id": "kpis", "component": "Grid", "columns": 4, "children": ["requests", "latency", "error-rate", "orders"]},
    {"id": "requests", "component": "Stat", "label": "Requests", "value": "1.28 M", "delta": "+6.2%", "tone": "neutral", "caption": "vs. the previous 24 hours"},
    {"id": "latency", "component": "Stat", "label": "p95 latency", "value": "412 ms", "delta": "+38%", "tone": "negative"},
    {"id": "error-rate", "component": "Stat", "label": "Error rate", "value": "0.84%", "delta": "+0.31 pt", "tone": "warning"},
    {"id": "orders", "component": "Stat", "label": "Orders", "value": "18,407", "delta": "+2.1%", "tone": "positive"},
    {"id": "errors", "component": "Section", "title": "Top errors", "description": "Grouped by exception, most frequent first", "child": "error-table"},
    {"id": "error-table", "component": "Table", "columns": [{"key": "error", "title": "Error"}, {"key": "endpoint", "title": "Endpoint"}, {"key": "count", "title": "Events"}, {"key": "users", "title": "Users"}], "rows": {"path": "/errors"}},
    {"id": "deploys", "component": "Collapsible", "title": "Recent deploys", "child": "deploy-list"},
    {"id": "deploy-list", "component": "List", "children": {"componentId": "deploy", "path": "/deploys"}},
    {"id": "deploy", "component": "ListItem", "title": {"path": "version"}, "subtitle": {"path": "summary"}, "icon": "upload", "meta": ["deploy-when"]},
    {"id": "deploy-when", "component": "Badge", "text": {"path": "when"}}
  ],
  "data": {
    "errors": [
      {"error": "PaymentTimeout", "endpoint": "POST /checkout", "count": 1204, "users": 612},
      {"error": "CartLocked", "endpoint": "PUT /cart", "count": 377, "users": 290},
      {"error": "AddressInvalid", "endpoint": "POST /checkout", "count": 141, "users": 133}
    ],
    "deploys": [
      {"version": "v2.41.0", "summary": "Retry the payment provider on 504", "when": "2 h ago"},
      {"version": "v2.40.3", "summary": "Raise the cart lock timeout to 5 s", "when": "Yesterday"}
    ]
  }
}
~~~

### List and detail: a List of ListItems beside a detail Section

~~~json
{
  "title": "Open pull requests",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "panes"]},
    {"id": "header", "component": "Header", "title": "Open pull requests", "subtitle": "claxedo/app · 3 awaiting review", "icon": "folder"},
    {"id": "panes", "component": "Grid", "columns": 2, "children": ["queue", "detail"]},
    {"id": "queue", "component": "Section", "title": "Queue", "variant": "plain", "child": "pr-list"},
    {"id": "pr-list", "component": "List", "children": {"componentId": "pr", "path": "/prs"}},
    {"id": "pr", "component": "ListItem", "title": {"path": "title"}, "subtitle": {"path": "byline"}, "selected": {"path": "selected"}, "meta": ["pr-checks"], "actions": ["pr-open"]},
    {"id": "pr-checks", "component": "Badge", "text": {"path": "checks"}},
    {"id": "pr-open", "component": "Button", "variant": "borderless", "child": "pr-open-label", "action": {"event": {"name": "openPullRequest", "context": {"number": {"path": "number"}}}}},
    {"id": "pr-open-label", "component": "Text", "text": "Details"},
    {"id": "detail", "component": "Section", "title": {"path": "/selected/title"}, "description": {"path": "/selected/byline"}, "actions": ["merge"], "child": "detail-body"},
    {"id": "merge", "component": "Button", "variant": "primary", "icon": "check", "child": "merge-label", "action": {"event": {"name": "mergePullRequest", "context": {"number": {"path": "/selected/number"}}}}},
    {"id": "merge-label", "component": "Text", "text": "Merge pull request"},
    {"id": "detail-body", "component": "Column", "children": ["detail-facts", "detail-diff"]},
    {"id": "detail-facts", "component": "KeyValue", "items": {"path": "/selected/facts"}},
    {"id": "detail-diff", "component": "DiffStat", "additions": {"path": "/selected/additions"}, "deletions": {"path": "/selected/deletions"}}
  ],
  "data": {
    "prs": [
      {"number": 4182, "title": "Stream tool output into the transcript", "byline": "#4182 · mira · updated 14 min ago", "checks": "Checks passing", "selected": true},
      {"number": 4177, "title": "Fix the flaky login test on Windows", "byline": "#4177 · devon · updated 2 h ago", "checks": "1 check failing", "selected": false},
      {"number": 4169, "title": "Cache model catalogs per provider", "byline": "#4169 · kai · updated yesterday", "checks": "Checks running", "selected": false}
    ],
    "selected": {
      "number": 4182,
      "title": "Stream tool output into the transcript",
      "byline": "#4182 · mira · updated 14 min ago",
      "additions": 214,
      "deletions": 37,
      "facts": [
        {"label": "Branch", "value": "mira/stream-tool-output"},
        {"label": "Reviewers", "value": "devon, kai"},
        {"label": "Checks", "value": "14 of 14 passing"},
        {"label": "Files changed", "value": "9"}
      ]
    }
  }
}
~~~

### Form: a Section per group, a two-column Grid, one action row

~~~json
{
  "title": "New deploy target",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "connection", "options", "actions"]},
    {"id": "header", "component": "Header", "title": "New deploy target", "subtitle": "Where this workspace ships its builds", "icon": "upload"},
    {"id": "connection", "component": "Section", "title": "Connection", "child": "connection-fields"},
    {"id": "connection-fields", "component": "Grid", "columns": 2, "children": ["name", "region", "host", "port"]},
    {"id": "name", "component": "TextField", "label": "Name", "value": {"path": "/target/name"}},
    {"id": "region", "component": "ChoicePicker", "label": "Region", "variant": "mutuallyExclusive", "displayStyle": "dropdown", "options": [{"label": "US East (Virginia)", "value": "us-east-1"}, {"label": "EU West (Ireland)", "value": "eu-west-1"}, {"label": "Asia Pacific (Tokyo)", "value": "ap-northeast-1"}], "value": {"path": "/target/region"}},
    {"id": "host", "component": "TextField", "label": "Host", "value": {"path": "/target/host"}},
    {"id": "port", "component": "TextField", "label": "Port", "variant": "number", "validationRegexp": "[0-9]{2,5}", "value": {"path": "/target/port"}},
    {"id": "options", "component": "Section", "title": "Options", "description": "You can change these later", "child": "option-fields"},
    {"id": "option-fields", "component": "Column", "children": ["autoscale", "previews"]},
    {"id": "autoscale", "component": "Switch", "label": "Scale with traffic", "value": {"path": "/target/autoscale"}},
    {"id": "previews", "component": "Switch", "label": "Deploy a preview for every pull request", "value": {"path": "/target/previews"}},
    {"id": "actions", "component": "Row", "justify": "end", "children": ["create"]},
    {"id": "create", "component": "Button", "variant": "primary", "icon": "add", "child": "create-label", "action": {"event": {"name": "createDeployTarget", "context": {"name": {"path": "/target/name"}, "region": {"path": "/target/region"}, "host": {"path": "/target/host"}, "port": {"path": "/target/port"}, "autoscale": {"path": "/target/autoscale"}, "previews": {"path": "/target/previews"}}}}},
    {"id": "create-label", "component": "Text", "text": "Create target"}
  ],
  "data": {"target": {"name": "", "region": ["eu-west-1"], "host": "", "port": "443", "autoscale": true, "previews": false}}
}
~~~

A plugin page adds a \`borderless\` Cancel before the primary button in the same Row. An agent reply leaves it out: not pressing is cancelling.

### Board: a Grid of Sections, each with a List template

~~~json
{
  "title": "Sprint 42 board",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "lanes"]},
    {"id": "header", "component": "Header", "title": "Sprint 42", "subtitle": "13–24 Oct · 21 of 34 points done", "icon": "calendarToday", "badges": ["sprint-state"], "actions": ["add-card"]},
    {"id": "sprint-state", "component": "Badge", "text": "On track", "variant": "success"},
    {"id": "add-card", "component": "Button", "icon": "add", "child": "add-card-label", "action": {"event": {"name": "addSprintCard"}}},
    {"id": "add-card-label", "component": "Text", "text": "Add card"},
    {"id": "lanes", "component": "Grid", "columns": 3, "children": ["todo", "doing", "review"]},
    {"id": "todo", "component": "Section", "title": "To do", "description": "2 cards · 8 points", "child": "todo-cards"},
    {"id": "todo-cards", "component": "List", "children": {"componentId": "card", "path": "/todo"}},
    {"id": "doing", "component": "Section", "title": "In progress", "description": "2 cards · 5 points", "child": "doing-cards"},
    {"id": "doing-cards", "component": "List", "children": {"componentId": "card", "path": "/doing"}},
    {"id": "review", "component": "Section", "title": "In review", "description": "No cards", "child": "review-empty"},
    {"id": "review-empty", "component": "EmptyState", "title": "Nothing in review", "description": "A card moves here when its pull request opens."},
    {"id": "card", "component": "ListItem", "title": {"path": "title"}, "subtitle": {"path": "owner"}, "meta": ["card-points"], "actions": ["card-advance"]},
    {"id": "card-points", "component": "Badge", "text": {"path": "points"}},
    {"id": "card-advance", "component": "Button", "variant": "borderless", "icon": "arrowForward", "child": "card-advance-label", "action": {"event": {"name": "advanceSprintCard", "context": {"card": {"path": "id"}}}}},
    {"id": "card-advance-label", "component": "Text", "text": "Advance"}
  ],
  "data": {
    "todo": [
      {"id": "CLX-311", "title": "Export usage as CSV", "owner": "kai", "points": "5 pts"},
      {"id": "CLX-318", "title": "Remember the last opened pane", "owner": "mira", "points": "3 pts"}
    ],
    "doing": [
      {"id": "CLX-297", "title": "Retry relay connects with backoff", "owner": "devon", "points": "3 pts"},
      {"id": "CLX-305", "title": "Show quota in the composer", "owner": "ana", "points": "2 pts"}
    ]
  }
}
~~~

### Settings: Header with the save action, plain-language Sections

~~~json
{
  "title": "Notification settings",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "channels", "digest", "reset-section"]},
    {"id": "header", "component": "Header", "title": "Notifications", "subtitle": "Applies to every project in this workspace", "icon": "notifications", "actions": ["save"]},
    {"id": "save", "component": "Button", "variant": "primary", "child": "save-label", "action": {"event": {"name": "saveNotificationSettings", "context": {"email": {"path": "/settings/email"}, "desktop": {"path": "/settings/desktop"}, "mentionsOnly": {"path": "/settings/mentionsOnly"}, "digest": {"path": "/settings/digest"}, "digestTime": {"path": "/settings/digestTime"}}}}},
    {"id": "save-label", "component": "Text", "text": "Save changes"},
    {"id": "channels", "component": "Section", "title": "Channels", "description": "Where Claxedo reaches you when a session needs you", "child": "channel-fields"},
    {"id": "channel-fields", "component": "Column", "children": ["email", "desktop", "mentions-only"]},
    {"id": "email", "component": "Switch", "label": "Email", "value": {"path": "/settings/email"}},
    {"id": "desktop", "component": "Switch", "label": "Desktop notifications", "value": {"path": "/settings/desktop"}},
    {"id": "mentions-only", "component": "CheckBox", "label": "Only when I am mentioned", "value": {"path": "/settings/mentionsOnly"}},
    {"id": "digest", "component": "Section", "title": "Daily digest", "child": "digest-fields"},
    {"id": "digest-fields", "component": "Grid", "columns": 2, "children": ["digest-days", "digest-time"]},
    {"id": "digest-days", "component": "ChoicePicker", "label": "Send on", "variant": "mutuallyExclusive", "displayStyle": "chips", "options": [{"label": "Never", "value": "off"}, {"label": "Weekdays", "value": "weekdays"}, {"label": "Every day", "value": "daily"}], "value": {"path": "/settings/digest"}},
    {"id": "digest-time", "component": "DateTimeInput", "label": "Send at", "enableDate": false, "enableTime": true, "value": {"path": "/settings/digestTime"}},
    {"id": "reset-section", "component": "Section", "title": "Reset notifications", "variant": "plain", "actions": ["reset"], "child": "reset-note"},
    {"id": "reset-note", "component": "Text", "variant": "caption", "text": "Turns email and desktop back on and sends the digest on weekdays at 09:00."},
    {"id": "reset", "component": "Button", "icon": "refresh", "child": "reset-label", "action": {"event": {"name": "resetNotificationSettings"}}},
    {"id": "reset-label", "component": "Text", "text": "Reset to defaults"}
  ],
  "data": {"settings": {"email": true, "desktop": false, "mentionsOnly": true, "digest": ["weekdays"], "digestTime": "09:00"}}
}
~~~

### Agent result: a Callout, the facts, the next step

~~~json
{
  "title": "Migration applied",
  "components": [
    {"id": "root", "component": "Column", "children": ["outcome", "details", "statements", "next"]},
    {"id": "outcome", "component": "Callout", "tone": "success", "title": "Migration 0042_invoice_due_index applied to prod-eu", "text": "Finished in 3.4 s. No rows were rewritten and no lock was held longer than 120 ms."},
    {"id": "details", "component": "Section", "title": "Details", "child": "facts"},
    {"id": "facts", "component": "KeyValue", "items": [{"label": "Database", "value": "billing (PostgreSQL 16.4)"}, {"label": "Index", "value": "invoices_due_at_idx"}, {"label": "Index size", "value": "184 MB"}, {"label": "Rollback script", "value": "0042_invoice_due_index.down.sql"}]},
    {"id": "statements", "component": "Collapsible", "title": "Statement run", "child": "statement"},
    {"id": "statement", "component": "Code", "language": "sql", "text": "CREATE INDEX CONCURRENTLY invoices_due_at_idx ON invoices (due_at) WHERE paid_at IS NULL;"},
    {"id": "next", "component": "Row", "justify": "end", "children": ["rollback", "smoke"]},
    {"id": "rollback", "component": "Button", "icon": "arrowBack", "child": "rollback-label", "action": {"event": {"name": "rollBackMigration", "context": {"migration": "0042_invoice_due_index", "environment": "prod-eu"}}}},
    {"id": "rollback-label", "component": "Text", "text": "Roll back"},
    {"id": "smoke", "component": "Button", "variant": "primary", "icon": "play", "child": "smoke-label", "action": {"event": {"name": "runSmokeTests", "context": {"environment": "prod-eu"}}}},
    {"id": "smoke-label", "component": "Text", "text": "Run smoke tests"}
  ]
}
~~~

A failure has the same shape: a \`danger\` Callout that says what failed and why, the facts that explain it, and the fix as the primary action.

## Interaction rules

- Only a Button sends anything. An input writes into the data model inside the app; nothing leaves the surface until a Button fires.
- Bind every input a Button depends on into its \`context\` (\`"name": {"path": "/target/name"}\`). The receiver sees only the context, never the model.
- Name the event for what it does, in camelCase (\`approveRelease\`, \`createDeployTarget\`). It is what the agent-reply confirmation shows ("Send “approveRelease” to the agent?") and what a plugin's \`action\` handler switches on.
- Inside a template (\`children: {"componentId": ..., "path": ...}\`) a path without a leading \`/\` reads the current item (\`{"path": "title"}\`); one with \`/\` reads from the root. A Button in a template sends its item's key: \`"context": {"card": {"path": "id"}}\`.
- Give each template item a stable key in the data (\`id\`, \`number\`) and send that, never a list index.
- Keep component ids stable and descriptive (\`create\`, \`pr-checks\`). Sending a component again with the same id replaces it; a renamed id leaves the old one behind.
- A plugin patches the exact path that changed (\`/prs/1/checks\`, \`/target/port\`), not the whole model. It sends \`updateComponents\` only when structure changes (a Callout appears, a Section is added), and then only the new or changed components and the parent whose children changed.
- Validate in the handler. Show a problem as a \`danger\` Callout (it blocks) or a \`warning\` Callout (it does not) directly above the action row, naming the field and the fix: "Port 80 is already used by billing-api. Choose another port." Remove it on the next success. A TextField's \`validationRegexp\` covers format only.
- Destructive actions confirm first. A plugin awaits \`api.ui.confirm({ title, description, confirmLabel })\` with the button's own verb ("Delete target"). An agent reply adds nothing: the app asks the person before every press is sent.
- An agent reply is a snapshot. A press reaches the agent as a new user message, \`Surface action "createDeployTarget" on "New deploy target": {...}\`; answer with text or a new \`ui_show\` that shows the result, not the same form again.
- Show work in place: a plugin replaces the action row with a labelled Spinner ("Creating target…") or Progress, then shows the outcome in a Callout.
- A Button always has a Text child with its label, even when it has an \`icon\`. Give \`accessibility.label\` to anything whose text is ambiguous out of context.

## Anti-patterns

| Instead of | Do |
| --- | --- |
| Buttons stacked in a Column, each stretched full width | Page actions in the Header's \`actions\`, group actions in the Section's \`actions\`, form actions in a Row with \`"justify": "end"\` |
| Inputs scattered across Rows | A Grid, usually \`"columns": 2\`; it falls back to one column when narrow |
| One giant Card holding everything | One Section per group; a Card only for a single standalone item |
| Status as a coloured Icon or Text | A Badge or Callout with a word and a tone |
| Paragraphs of Text listing facts ("Region: eu-west-1. Owner: …") | KeyValue for one record, Table for many |
| More than 7 blocks directly under the root | Tabs for parallel views, Collapsible for secondary detail |
| Text h1/h2 as page and group headings | Header and Section titles |
| A Row of Stats | A Grid of Stats, 2–4 columns |
| A List bound to an empty array | An EmptyState that says what to do |
| Two primary buttons, or "OK", "Submit", "Yes" | One primary whose label names the outcome |
| Preformatted numbers in a Table ("1,204 ms") | JSON numbers, with the unit in the column title |

## Before you show it

1. One component has the id \`root\`, and every other component is reachable from it.
2. The view opens with a Header, or a Callout for a short result.
3. Related content sits in titled Sections, with at most 7 blocks under the root.
4. There is at most one \`primary\` Button, and every label is a specific verb phrase.
5. Each Button's \`context\` carries every input it needs, and a template Button sends its item's key.
6. Template bindings are relative, root bindings start with \`/\`, and every path exists in \`data\`.
7. Every status is a word in a Badge or Callout, never colour alone.
8. A collection that is empty shows an EmptyState instead.
9. Numbers carry units; Table numbers are JSON numbers.
10. Fields sit in a Grid; actions sit in a Header, a Section's \`actions\` or a right-aligned Row.
11. Secondary detail is behind a Collapsible or Tabs.
12. Every title, label and value is real text in sentence case.
`
