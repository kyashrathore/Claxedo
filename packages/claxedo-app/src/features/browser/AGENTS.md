# Browser Tab Feature

The Claxedo-native in-app browser tab: the webview host and its stores
(history, comments, address-bar/url parsing, pane context). A self-contained
feature surface — it does not reach into the session, pages, or terminal
subsystems.

```json
{
  "owns": "In-app browser tab: webview host + history/comments/address-bar stores",
  "writerOf": [],
  "mustNotImport": ["@/pages/*", "../../pages/*", "@/components/*", "../../components/*", "@/session/*", "../../session/*", "@/terminal/*", "../../terminal/*"]
}
```
