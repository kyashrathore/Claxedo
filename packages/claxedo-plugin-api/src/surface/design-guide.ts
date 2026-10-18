export const SURFACE_DESIGN_GUIDE = `# Designing Claxedo surfaces

A surface is A2UI v0.9 that the Claxedo app draws with its own components: an agent's \`ui_show\` reply in the transcript, or an app plugin's surface page. The renderer already sets spacing, type scale, borders, button widths and light and dark colours. Your job is structure, wording and interaction. Every recipe below is a complete \`ui_show\` input that passes the check; a plugin sends the same \`components\` in \`updateComponents\` and the same \`data\` in \`updateDataModel\`.

## Principles

- One primary action per view: exactly one \`primary\` Button. The rest are \`default\`, or \`borderless\` for low-stakes ones (Details, Cancel).
- Hierarchy is Header → Section → content. A view opens with one Header, or with one Callout for a short agent result. Each group of related content is a titled Section. Never fake headings with Text h1/h2 in a Column.
- Group related fields in one Section and lay them out with a Grid, so the form reads left to right, top to bottom.
- Say state in words: a status is a Badge with a word ("Failing", "Merged") and a tone; an outcome or warning is a Callout. Never colour or an Icon alone.
- An empty collection is an EmptyState that says what to do next ("No deploy targets yet" / "Add one to ship from this workspace."), never a blank area.
- Progressive disclosure: secondary detail (logs, raw payloads, history) goes in a Collapsible, parallel views of the same thing in Tabs. The first screen answers the person's question. A Collapsible draws as a full-width disclosure row with a turning chevron, in the Section title's type, so give it a short noun-phrase title ("Burndown", "Rollout and targeting"), never a sentence or a button label.
- Never a wall of inputs. Past about six inputs, split into Sections; past three Sections of settings, use Tabs.
- Numbers carry units. A Stat value is formatted text ("412 ms", "1.28 M", "18,407"); its \`delta\` carries its own sign or arrow ("+6.2%", "▼ 12 ms") and its \`tone\` says whether the change is good, bad or a warning. Keep a Stat's caption to a few words: tiles in a Grid share one height and one footer line. A Table cell holds a JSON number so it right-aligns, with the unit in the column title ("p95 (ms)").
- Button labels are verbs naming the outcome: "Save changes", "Approve release", "Retry 3 failed jobs". Never "OK", "Submit" or "Yes". A destructive verb names its object: "Delete target".
- Titles in sentence case, under about 40 characters. Labels are nouns ("Region", not "Choose the region:"). Real words and data, never placeholders.
- A view or form ends with a Footer: the primary group in \`end\`, the primary Button last, secondary actions (Cancel, Reset) in \`start\`. Header \`actions\` are for page-level actions and Section \`actions\` for one group's actions, never for submitting a form.
- Pick the input for the value: a few discrete options are ChoicePicker \`chips\` (or a \`dropdown\` past about five), a number is a TextField with \`"variant": "number"\`, and a Slider only a bounded continuous value such as a percentage. Progress shows work happening, never a value to set.
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
| The actions that finish a view or form | \`Footer\`: \`start\` for secondary actions, \`end\` for the primary group with the primary Button last |
| One of a few options | \`ChoicePicker\` with \`chips\`; a \`dropdown\` past about five |
| A bounded continuous value | \`Slider\`; a small whole number is a number \`TextField\` |
| Nothing to show yet | \`EmptyState\` |

A Badge's \`variant\` may be bound, so a template row can carry its own tone: put the tone beside the status word in each item (\`{"status": "Failed", "tone": "danger"}\`) and bind both (\`"text": {"path": "status"}, "variant": {"path": "tone"}\`); an unknown tone draws neutral. The text still says the state, so colour is never the only signal.

## Provenance

Every surface opens with a source line the app draws above your content: the producer's glyph and name and what made it ("Pi · agent reply", "Sprint board · app plugin"). It says who made the surface, so a surface can never pass for the app's own UI. Authors do not set it and cannot hide it; never repeat it in a Header or a Text.

## Header

- Title: the object's name ("checkout-api", "Sprint 42"), not a sentence.
- Subtitle: one line of at most three facts joined by " · ", about 60 characters ("Production · eu-west-1 · 14 min ago"). Anything more is a Stat, a KeyValue row or a Badge. The app cuts a longer subtitle to one line on a desktop and two on a phone, with the full text on hover.
- Badges: one or two status words beside the title.
- Actions: at most two, a secondary one and at most one primary, aligned with the title line. More actions go to a Section's \`actions\` or the Footer.
- Icon: names the kind of object the view is about, never decoration. Leave it out when nothing below fits.

| The view is about | \`icon\` |
| --- | --- |
| A deploy, release or build | \`upload\` |
| A repository, project or folder | \`folder\` |
| An incident, alert or failing check | \`warning\` |
| A person, team or account | \`person\` |
| A sprint, schedule or event | \`calendarToday\` |
| Settings or configuration | \`settings\` |
| Notifications | \`notifications\` |
| Messages or email | \`mail\` |
| Billing or payments | \`payment\` |
| Access, secrets or security | \`lock\` |
| A region or location | \`locationOn\` |
| An order, cart or checkout | \`shoppingCart\` |
| Search results | \`search\` |

On a phone (under about 480 px) the Header reflows in a fixed order: the icon and title, the subtitle under the title, the badges on their own line, then the actions on their own row, left-aligned with the title, at equal height.

## Notices

A Callout is a notice about the view's state. Pick the tone by what it means, then the parts it needs:

| \`tone\` | Means | Colour | Use it when | \`action\` | \`dismissible\` |
| --- | --- | --- | --- | --- | --- |
| \`info\` | Context; nothing is wrong | Blue | A fact the person should know before acting | None | Yes when it is one-time knowledge |
| \`success\` | A lasting outcome worth keeping on screen | Green | The result of the run the view reports (a passing check is a Badge, a quick confirmation is not a Callout) | Optional, to view the result | Yes |
| \`warning\` | Needs attention soon; not blocking | Amber | Something degraded or about to expire | The fix, when one exists | No when it clears with the state (the producer removes it); yes when it is something to acknowledge |
| \`danger\` | Blocked: an error or a refused action | Red | The action failed or cannot run | Required: fix, retry, or go where it is fixed, unless the fix is the form right below it | Never while the problem lasts |

- One Callout per Section, at the top of the Section it concerns. A notice about the whole view sits directly under the Header.
- The title says what happened ("Port 80 is already in use"); the text says why and what to do next.
- \`action\` is the id of one Button, worded as the fix ("Choose another port", "Retry deploy"). \`dismissible\` adds a close button that hides the notice for this view; it comes back if the producer sends it again with a different title or text.
- The tone's colour and icon always come with words; never a coloured Callout without a title.

## Lists and rows

- A ListItem's \`meta\` is information (status Badges, counts) and \`actions\` are commands. Meta sits on its own line under the subtitle and wraps; actions keep their own column at the right, level with the title. In a narrow row (a phone, a board lane) the actions move together to the end of the meta line instead, and only take their own right-aligned line when they do not fit there. Chips wrap; buttons move as a group.
- The app trims a ListItem's title to one line (two on a phone) and its subtitle to two, with the full text on hover. Badge text and numbers are never cut, so keep them short.
- Icons, chips and buttons align with the first line of a wrapping title, never with its middle. CheckBox and Switch align their control with the first line of a two-line label.
- The app decides by the row's own width, not the screen's: in a narrow row (a lane of a four-column board, a phone) the row's actions move to the end of its \`meta\` line, beside the badges, and take their own end-aligned line only when the two do not fit or the row has no \`meta\`; they wrap inside the item, never run past its edge and never cover the title.
- Row actions follow "Actions: what shows, what waits" below: one \`primaryAction\`, icon-only \`actions\`.
- A selected row (\`selected\`) is shown with a faint tint only; do not add an Icon or Badge to mark it.

## Actions: what shows, what waits

A view that repeats rows of one kind (a List with a ListItem template) repeats every action on every row, so each row shows at most one text action and keeps the rest out of sight until the person points at it.

| Action | Where it goes | Shown | Style |
| --- | --- | --- | --- |
| The view's main action | Footer \`end\` (or Header \`actions\` on a page without a Footer) | Always | \`primary\`, one per view |
| A section-level action (Add, Refresh, Export) | Section \`actions\` | Always | \`default\`, or \`borderless\` for low stakes |
| The action most rows need (Open, Advance, Review) | ListItem \`primaryAction\` | Always | Drawn as a compact outlined button; leave \`variant\` out |
| Other per-row actions (Move back, Edit, Duplicate, Assign) | ListItem \`actions\` | On hover or keyboard focus with a mouse (their space is kept, so nothing moves); always on touch | Icon-only: give each an \`icon\`; its label becomes the accessible name and tooltip |
| A per-row destructive action (Delete, Remove) | ListItem \`actions\`, last, with \`"icon": "delete"\` | Like other row actions | Icon-only, red on hover and focus; confirm before acting |
| A bulk action on selected rows | Section \`actions\` | Only while something is selected (the producer adds and removes it) | \`default\` |

- At most one visible text action per repeated row: its \`primaryAction\`. Everything else in \`actions\` carries an \`icon\`.
- State is shown in the row (its icon, a meta Badge or \`selected\`); the hover action only changes it. A favourite row shows its star in \`meta\` or as its icon, not only on the hidden toggle.
- Never show contradictory controls together (Start and Stop, Revert with nothing pending). Show only the one that applies: put it in a List bound to a list of zero or one items that the producer updates.
- A Section header carries at most two actions, each a short verb phrase ("Add", "Export"). A longer label or a third action goes to a Footer.
- A toggle shows its state through its icon: bind the Button's \`icon\` to the item (\`"icon": {"path": "favouriteIcon"}\` with \`star\` or \`starOff\`, \`favorite\` or \`favoriteOff\`, \`lock\` or \`lockOpen\`) and its label to the action it will take ("Add to favourites", "Remove from favourites").
- Never a Link next to a Button in a row; a row's commands are Buttons.
- The same action sits in the same place on every row: one template, one order, the destructive action last.
- A row with no actions draws no action column, so leave \`primaryAction\` and \`actions\` out rather than sending empty ones.
- Every Button in one group is the same size; the renderer handles that. \`borderless\` is a quiet neutral button, not a link: the accent colour belongs to Links and the primary Button.
- A single item that is not repeated (a ListItem placed directly, not from a template) shows all of its actions at full size.

## Narrow screens

Every layout must hold at phone width (about 360 px). The app reflows it; the spec only has to avoid fixed widths and long unbroken strings.

- Grid columns collapse by what they hold, measured on the Grid's own width: a Grid of only Stats keeps two columns on a phone; a Grid of Sections or Cards becomes one column under about 560 px; other Grids go from 2–3 columns to one under 480 px, from 4 to two under 560 px, and from 5–6 to three then two.
- A Tabs strip wider than the screen scrolls sideways with faded edges, and the selected tab scrolls into view.
- Code wraps its long lines inside a surface, so nothing is cut off.
- A Table under 480 px stacks each row as a block of label and value pairs, so a Table never needs to scroll sideways. Keep it to about five columns; more belongs in a detail view.
- The Footer's \`end\` group spans the full width with equal-width buttons, the primary on the right; the \`start\` group moves to its own row below.
- Callout actions move under the text.

## Recipes

### Dashboard: Header, a Grid of Stats, then Sections

~~~json
{
  "title": "Checkout service health",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "kpis", "errors", "deploys", "footer"]},
    {"id": "header", "component": "Header", "title": "Checkout service", "subtitle": "Production · last 24 hours", "icon": "shoppingCart", "badges": ["health"], "actions": ["refresh"]},
    {"id": "health", "component": "Badge", "text": "Degraded", "variant": "warning"},
    {"id": "refresh", "component": "Button", "icon": "refresh", "child": "refresh-label", "action": {"event": {"name": "refreshCheckoutHealth"}}},
    {"id": "refresh-label", "component": "Text", "text": "Refresh"},
    {"id": "kpis", "component": "Grid", "columns": 4, "children": ["requests", "latency", "error-rate", "orders"]},
    {"id": "requests", "component": "Stat", "label": "Requests", "value": "1.28 M", "delta": "+6.2%", "tone": "neutral", "caption": "vs. yesterday"},
    {"id": "latency", "component": "Stat", "label": "p95 latency", "value": "412 ms", "delta": "▲ 38%", "tone": "negative", "caption": "SLO 300 ms"},
    {"id": "error-rate", "component": "Stat", "label": "Error rate", "value": "0.84%", "delta": "+0.31 pt", "tone": "warning"},
    {"id": "orders", "component": "Stat", "label": "Orders", "value": "18,407", "delta": "+2.1%", "tone": "positive"},
    {"id": "errors", "component": "Section", "title": "Top errors", "description": "Grouped by exception, most frequent first", "child": "error-table"},
    {"id": "error-table", "component": "Table", "columns": [{"key": "error", "title": "Error"}, {"key": "endpoint", "title": "Endpoint"}, {"key": "count", "title": "Events"}, {"key": "users", "title": "Users"}], "rows": {"path": "/errors"}},
    {"id": "deploys", "component": "Collapsible", "title": "Recent deploys", "child": "deploy-list"},
    {"id": "deploy-list", "component": "List", "children": {"componentId": "deploy", "path": "/deploys"}},
    {"id": "deploy", "component": "ListItem", "title": {"path": "version"}, "subtitle": {"path": "summary"}, "icon": "upload", "meta": ["deploy-when"]},
    {"id": "deploy-when", "component": "Badge", "text": {"path": "when"}},
    {"id": "footer", "component": "Footer", "start": ["runbook"], "end": ["incident"]},
    {"id": "runbook", "component": "Button", "variant": "borderless", "child": "runbook-label", "action": {"event": {"name": "openCheckoutRunbook"}}},
    {"id": "runbook-label", "component": "Text", "text": "Open runbook"},
    {"id": "incident", "component": "Button", "variant": "primary", "icon": "warning", "child": "incident-label", "action": {"event": {"name": "openCheckoutIncident", "context": {"service": "checkout"}}}},
    {"id": "incident-label", "component": "Text", "text": "Open an incident"}
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
    {"id": "pr", "component": "ListItem", "title": {"path": "title"}, "subtitle": {"path": "byline"}, "selected": {"path": "selected"}, "meta": ["pr-checks"], "primaryAction": "pr-open"},
    {"id": "pr-checks", "component": "Badge", "text": {"path": "checks"}},
    {"id": "pr-open", "component": "Button", "child": "pr-open-label", "action": {"event": {"name": "openPullRequest", "context": {"number": {"path": "number"}}}}},
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

### Form: a Section per group, a two-column Grid, a Footer

~~~json
{
  "title": "New deploy target",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "connection", "options", "footer"]},
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
    {"id": "footer", "component": "Footer", "end": ["create"]},
    {"id": "create", "component": "Button", "variant": "primary", "icon": "add", "child": "create-label", "action": {"event": {"name": "createDeployTarget", "context": {"name": {"path": "/target/name"}, "region": {"path": "/target/region"}, "host": {"path": "/target/host"}, "port": {"path": "/target/port"}, "autoscale": {"path": "/target/autoscale"}, "previews": {"path": "/target/previews"}}}}},
    {"id": "create-label", "component": "Text", "text": "Create target"}
  ],
  "data": {"target": {"name": "", "region": ["eu-west-1"], "host": "", "port": "443", "autoscale": true, "previews": false}}
}
~~~

A plugin page adds a \`borderless\` Cancel in the Footer's \`start\`. An agent reply leaves it out: not pressing is cancelling.

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
    {"id": "card", "component": "ListItem", "title": {"path": "title"}, "subtitle": {"path": "owner"}, "meta": ["card-points"], "primaryAction": "card-advance", "actions": ["card-assign", "card-remove"]},
    {"id": "card-points", "component": "Badge", "text": {"path": "points"}},
    {"id": "card-advance", "component": "Button", "icon": "arrowForward", "child": "card-advance-label", "action": {"event": {"name": "advanceSprintCard", "context": {"card": {"path": "id"}}}}},
    {"id": "card-advance-label", "component": "Text", "text": "Advance"},
    {"id": "card-assign", "component": "Button", "variant": "borderless", "icon": "person", "child": "card-assign-label", "action": {"event": {"name": "assignSprintCard", "context": {"card": {"path": "id"}}}}},
    {"id": "card-assign-label", "component": "Text", "text": "Assign"},
    {"id": "card-remove", "component": "Button", "variant": "borderless", "icon": "delete", "child": "card-remove-label", "action": {"event": {"name": "removeSprintCard", "context": {"card": {"path": "id"}}}}},
    {"id": "card-remove-label", "component": "Text", "text": "Remove card"}
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

### Settings: plain-language Sections, saved from the Footer

~~~json
{
  "title": "Notification settings",
  "components": [
    {"id": "root", "component": "Column", "children": ["header", "channels", "digest", "footer"]},
    {"id": "header", "component": "Header", "title": "Notifications", "subtitle": "Applies to every project in this workspace", "icon": "notifications"},
    {"id": "channels", "component": "Section", "title": "Channels", "description": "Where Claxedo reaches you when a session needs you", "child": "channel-fields"},
    {"id": "channel-fields", "component": "Column", "children": ["email", "desktop", "mentions-only"]},
    {"id": "email", "component": "Switch", "label": "Email", "value": {"path": "/settings/email"}},
    {"id": "desktop", "component": "Switch", "label": "Desktop notifications", "value": {"path": "/settings/desktop"}},
    {"id": "mentions-only", "component": "CheckBox", "label": "Only when I am mentioned", "value": {"path": "/settings/mentionsOnly"}},
    {"id": "digest", "component": "Section", "title": "Daily digest", "child": "digest-fields"},
    {"id": "digest-fields", "component": "Grid", "columns": 2, "children": ["digest-days", "digest-time"]},
    {"id": "digest-days", "component": "ChoicePicker", "label": "Send on", "variant": "mutuallyExclusive", "displayStyle": "chips", "options": [{"label": "Never", "value": "off"}, {"label": "Weekdays", "value": "weekdays"}, {"label": "Every day", "value": "daily"}], "value": {"path": "/settings/digest"}},
    {"id": "digest-time", "component": "DateTimeInput", "label": "Send at", "enableDate": false, "enableTime": true, "value": {"path": "/settings/digestTime"}},
    {"id": "footer", "component": "Footer", "start": ["reset"], "end": ["save"]},
    {"id": "reset", "component": "Button", "variant": "borderless", "icon": "refresh", "child": "reset-label", "action": {"event": {"name": "resetNotificationSettings"}}},
    {"id": "reset-label", "component": "Text", "text": "Reset to defaults"},
    {"id": "save", "component": "Button", "variant": "primary", "child": "save-label", "action": {"event": {"name": "saveNotificationSettings", "context": {"email": {"path": "/settings/email"}, "desktop": {"path": "/settings/desktop"}, "mentionsOnly": {"path": "/settings/mentionsOnly"}, "digest": {"path": "/settings/digest"}, "digestTime": {"path": "/settings/digestTime"}}}}},
    {"id": "save-label", "component": "Text", "text": "Save changes"}
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
    {"id": "outcome", "component": "Callout", "tone": "success", "title": "Migration 0042_invoice_due_index applied to prod-eu", "text": "Finished in 3.4 s. No rows were rewritten and no lock was held longer than 120 ms.", "dismissible": true},
    {"id": "details", "component": "Section", "title": "Details", "child": "facts"},
    {"id": "facts", "component": "KeyValue", "items": [{"label": "Database", "value": "billing (PostgreSQL 16.4)"}, {"label": "Index", "value": "invoices_due_at_idx"}, {"label": "Index size", "value": "184 MB"}, {"label": "Rollback script", "value": "0042_invoice_due_index.down.sql"}]},
    {"id": "statements", "component": "Collapsible", "title": "Statement run", "child": "statement"},
    {"id": "statement", "component": "Code", "language": "sql", "text": "CREATE INDEX CONCURRENTLY invoices_due_at_idx ON invoices (due_at) WHERE paid_at IS NULL;"},
    {"id": "next", "component": "Footer", "start": ["rollback"], "end": ["smoke"]},
    {"id": "rollback", "component": "Button", "icon": "arrowBack", "child": "rollback-label", "action": {"event": {"name": "rollBackMigration", "context": {"migration": "0042_invoice_due_index", "environment": "prod-eu"}}}},
    {"id": "rollback-label", "component": "Text", "text": "Roll back"},
    {"id": "smoke", "component": "Button", "variant": "primary", "icon": "play", "child": "smoke-label", "action": {"event": {"name": "runSmokeTests", "context": {"environment": "prod-eu"}}}},
    {"id": "smoke-label", "component": "Text", "text": "Run smoke tests"}
  ]
}
~~~

A failure has the same shape: a \`danger\` Callout that says what failed and why, with the fix as its \`action\` and never \`dismissible\`, then the facts that explain it.

## Interaction rules

- Only a Button sends anything. An input writes into the data model inside the app; nothing leaves the surface until a Button fires.
- Bind every input a Button depends on into its \`context\` (\`"name": {"path": "/target/name"}\`). The receiver sees only the context, never the model.
- Name the event for what it does, in camelCase (\`approveRelease\`, \`createDeployTarget\`). It is what the agent-reply confirmation shows ("Send “approveRelease” to the agent?") and what a plugin's \`action\` handler switches on.
- Inside a template (\`children: {"componentId": ..., "path": ...}\`) a path without a leading \`/\` reads the current item (\`{"path": "title"}\`); one with \`/\` reads from the root. A Button in a template sends its item's key: \`"context": {"card": {"path": "id"}}\`.
- Give each template item a stable key in the data (\`id\`, \`number\`) and send that, never a list index.
- Keep component ids stable and descriptive (\`create\`, \`pr-checks\`). Sending a component again with the same id replaces it; a renamed id leaves the old one behind.
- A plugin patches the exact path that changed (\`/prs/1/checks\`, \`/target/port\`), not the whole model. It sends \`updateComponents\` only when structure changes (a Callout appears, a Section is added), and then only the new or changed components and the parent whose children changed.
- Validate in the handler. Show a problem as a \`danger\` Callout (it blocks) or a \`warning\` Callout (it does not) directly above the Footer, naming the field and the fix: "Port 80 is already used by billing-api. Choose another port." Remove it on the next success. A TextField's \`validationRegexp\` covers format only.
- Destructive actions confirm first. A plugin awaits \`api.ui.confirm({ title, description, confirmLabel })\` with the button's own verb ("Delete target"). An agent reply adds nothing: the app asks the person before every press is sent.
- An agent reply is a snapshot. A press reaches the agent as a new user message, \`Surface action "createDeployTarget" on "New deploy target": {...}\`; answer with text or a new \`ui_show\` that shows the result, not the same form again.
- Show work in place: a plugin replaces the Footer's buttons with a labelled Spinner ("Creating target…") or Progress, then shows the outcome in a Callout.
- A Button always has a Text child with its label, even when it has an \`icon\`. Give \`accessibility.label\` to anything whose text is ambiguous out of context.

## Anti-patterns

| Instead of | Do |
| --- | --- |
| Buttons stacked in a Column, each stretched full width | Page actions in the Header's \`actions\`, group actions in the Section's \`actions\`, the closing actions in a Footer |
| Actions dumped in a left-aligned Row at the end | A Footer: secondary actions in \`start\`, the primary group in \`end\` with the primary Button last |
| A Slider for a handful of values or a count | ChoicePicker \`chips\`, or a number TextField |
| Progress used as a meter the person sets | A Slider for a bounded value; Progress only for work happening |
| Inputs scattered across Rows | A Grid, usually \`"columns": 2\`; it falls back to one column when narrow |
| One giant Card holding everything | One Section per group; a Card only for a single standalone item |
| Status as a coloured Icon or Text | A Badge or Callout with a word and a tone |
| Paragraphs of Text listing facts ("Region: eu-west-1. Owner: …") | KeyValue for one record, Table for many |
| More than 7 blocks directly under the root | Tabs for parallel views, Collapsible for secondary detail |
| Text h1/h2 as page and group headings | Header and Section titles |
| A Row of Stats | A Grid of Stats, 2–4 columns |
| A List bound to an empty array | An EmptyState that says what to do |
| Two primary buttons, or "OK", "Submit", "Yes" | One primary whose label names the outcome |
| A Header subtitle listing every fact | Three facts at most; the rest as Stats, KeyValue rows or Badges |
| Three or more Header actions | Two at most; the rest in a Section's \`actions\` or the Footer |
| A \`danger\` Callout with no way forward, or one that can be closed | A \`danger\` Callout with an \`action\` that fixes it, and no close button |
| Several Callouts stacked in one place | One per Section, at the top of the Section it concerns |
| Badges and buttons mixed in a row's \`actions\` | Badges in \`meta\`, commands in \`primaryAction\` and \`actions\` |
| Every row showing several text buttons and links in different styles | One \`primaryAction\` per row; the rest icon-only in \`actions\`, shown on hover |
| A decorative Header icon | An icon that names the object type, or none |
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
10. Fields sit in a Grid; the view's closing actions sit in a Footer with the primary Button last, other actions in a Header's or a Section's \`actions\`.
11. Secondary detail is behind a Collapsible or Tabs.
12. Every title, label and value is real text in sentence case.
13. The Header subtitle has at most three facts; the Header has at most two actions; its icon names the object type.
14. Each Callout has the tone that matches its meaning, a title, and an \`action\` when it is \`danger\`; at most one per Section.
15. A view with inputs ends with a Footer.
16. Each repeated row has at most one text action (\`primaryAction\`); every Button in its \`actions\` has an \`icon\`, and a destructive one uses \`delete\`.
`
