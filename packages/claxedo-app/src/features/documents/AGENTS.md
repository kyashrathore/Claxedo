# Documents Feature

The Documents feature owns the metadata-only index, Markdown API client,
rich/source editor composition, serialized autosave and conflict recovery,
snapshot actions, document-to-work actions, and the `page` / `pages-index`
surface wrappers retained by the workbench route contract.

Document content is always Markdown from the `/documents` API. The editor
uses the persistence controller for every human edit, including selected-text
agent transforms. Repository files remain repository-owned; managed files are
opened through the same document workspace contract. Session and WorkGraph
capabilities enter through `app-ports.ts` rather than direct cross-feature
imports.

```json
{
  "owns": "Document API data, Markdown editing, persistence state, document actions, and workbench content surfaces",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/browser/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/settings/*", "@/features/terminal/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```
