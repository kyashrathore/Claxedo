export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orchestrator Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

  :root {
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono: 'IBM Plex Mono', 'Menlo', monospace;
    --fs-xs: 10px; --fs-sm: 11px; --fs-base: 13px; --fs-md: 14px; --fs-lg: 16px;
    --fw-regular: 400; --fw-medium: 500; --fw-semi: 600;
    --sp: 4px;
    --r-xs: 2px; --r-sm: 4px; --r-md: 6px; --r-lg: 8px; --r-xl: 10px;
    /* Smoke dark scale */
    --sd1: #131010; --sd2: #1b1818; --sd3: #252121; --sd4: #2d2828; --sd5: #343030;
    --sd6: #3e3939; --sd7: #4b4646; --sd8: #645f5f; --sd9: #716c6b; --sd10: #7f7979;
    --sd11: #b7b1b1; --sd12: #f1ecec;
    /* Smoke dark alpha */
    --sda3: #edd5d516; --sda5: #f5e8e826; --sda6: #f5e8e831; --sda7: #f7ecec3f;
    --sda8: #faf5f559; --sda9: #faf5f467; --sda11: #fcf9f9b2; --sda12: #fdfbfbf0;
    /* Accents */
    --cobalt-9: #034cff; --cobalt-11: #89b5ff; --cobalt-12: #cde2ff; --cobalt-dim: #0c2255;
    --apple-9: #12c905; --apple-11: #37db2e; --apple-12: #aff7a8; --apple-dim: #152d13;
    --ember-9: #fc533a; --ember-11: #ff917b; --ember-12: #ffd1c8; --ember-dim: #3c140d;
    --solaris-9: #fcd53a; --solaris-11: #fdd63c; --solaris-12: #faebb5; --solaris-dim: #2a2307;
    --lilac-9: #edb2f1; --lilac-11: #dca2e0; --lilac-12: #edd8ef; --lilac-dim: #2f1e31;
    /* Semantic badge bgs */
    --bg-apple: rgba(51, 255, 34, 0.12); --bg-ember: rgba(251, 34, 0, 0.18);
    --bg-solaris: rgba(254, 187, 0, 0.11); --bg-lilac: rgba(236, 112, 251, 0.14);
    --bg-cobalt: rgba(0, 77, 255, 0.29); --bg-smoke: rgba(237, 213, 213, 0.09);
    /* Syntax (dark) */
    --syn-kw: var(--sda9); --syn-str: #00ceb9; --syn-num: #93e9f6; --syn-cm: var(--sd9);
    --syn-fn: #ff9ae2; --syn-op: var(--sda9); --syn-type: #ecf58c; --syn-prim: #ffba92;
    /* Shadows */
    --shadow-xs: 0 1px 2px -0.5px rgba(0,0,0,.06), 0 .5px 1.5px 0 rgba(0,0,0,.08), 0 1px 3px 0 rgba(0,0,0,.1);
    --shadow-md: 0 6px 12px -2px rgba(0,0,0,.1), 0 4px 8px -2px rgba(0,0,0,.15), 0 1px 2px rgba(0,0,0,.15);
    --shadow-lg: 0 16px 48px -6px rgba(0,0,0,.15), 0 6px 12px -2px rgba(0,0,0,.1), 0 1px 2.5px rgba(0,0,0,.1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    font-feature-settings: 'ss03' 1;
    background: var(--sd1);
    color: var(--sd11);
    font-size: var(--fs-base);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Custom scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--sd5); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--sd6); }

  button {
    cursor: pointer; font-family: var(--font-sans); font-size: var(--fs-sm);
    padding: 6px 12px; border: 1px solid var(--sda7); background: var(--sd3);
    color: var(--sd11); border-radius: var(--r-md); transition: all 0.15s ease;
    font-weight: var(--fw-medium);
  }
  button:hover { background: var(--sd4); border-color: var(--sda8); }
  button.primary { background: var(--apple-dim); border-color: rgba(51,255,34,0.2); color: var(--apple-11); }
  button.primary:hover { background: #1d5b19; border-color: rgba(51,255,34,0.3); }
  button.danger { background: var(--ember-dim); border-color: rgba(251,34,0,0.25); color: var(--ember-11); }
  button.danger:hover { background: #530e05; border-color: rgba(251,34,0,0.35); }

  input, textarea, select {
    font-family: var(--font-sans); font-size: var(--fs-sm);
    padding: 6px 10px; border: 1px solid var(--sda7); background: var(--sd2);
    color: var(--sd12); border-radius: var(--r-md); outline: none; transition: border-color 0.15s ease;
  }
  input:focus, textarea:focus { border-color: var(--cobalt-11); box-shadow: 0 0 0 2px rgba(0,77,255,0.15); }
  textarea { resize: vertical; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--sda6);
    background: var(--sd2); backdrop-filter: blur(8px);
  }
  .header h1 { font-size: 14px; font-weight: var(--fw-semi); color: var(--sd12); letter-spacing: -0.2px; }

  .container { display: flex; height: calc(100vh - 43px); }

  .sidebar {
    width: 280px; min-width: 280px; border-right: 1px solid var(--sda6);
    overflow-y: auto; background: var(--sd1);
  }
  .main { flex: 1; overflow-y: auto; padding: 16px; background: var(--sd1); }

  .section { padding: 12px; border-bottom: 1px solid var(--sda5); }
  .section h3 {
    font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--sd9); margin-bottom: 8px; font-weight: var(--fw-medium);
  }

  .create-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .create-row input { flex: 1; }

  .item {
    padding: 8px; border-radius: var(--r-md); cursor: pointer; margin-bottom: 2px;
    display: flex; align-items: center; gap: 8px; transition: background 0.12s ease;
    border: 1px solid transparent;
  }
  .item:hover { background: var(--sd2); }
  .item.selected { background: rgba(0,77,255,0.08); border-color: rgba(0,77,255,0.2); }
  .item .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot.active { background: var(--apple-11); }
  .dot.completed { background: var(--sd9); }
  .dot.failed { background: var(--ember-9); }
  .dot.pending { background: var(--solaris-9); }
  .dot.running { background: var(--apple-11); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .item .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--sd11); }
  .item .meta { font-size: var(--fs-xs); color: var(--sd9); margin-left: auto; flex-shrink: 0; }

  .panel {
    background: var(--sd2); border: 1px solid var(--sda6);
    border-radius: var(--r-lg); padding: 16px; margin-bottom: 12px;
    box-shadow: var(--shadow-xs);
  }
  .panel h2 { font-size: var(--fs-md); margin-bottom: 12px; color: var(--sd12); font-weight: var(--fw-semi); letter-spacing: -0.16px; }
  .panel h4 { font-size: 12px; margin: 12px 0 6px; color: var(--sd9); }

  .kv { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; font-size: 12px; margin-bottom: 8px; }
  .kv .k { color: var(--sd9); }
  .kv .v { color: var(--sd11); word-break: break-all; }

  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: var(--fs-xs); font-weight: var(--fw-semi);
  }
  .badge.active { background: var(--bg-apple); color: var(--apple-11); }
  .badge.completed { background: var(--bg-smoke); color: var(--sd9); }
  .badge.failed { background: var(--bg-ember); color: var(--ember-11); }
  .badge.pending { background: var(--bg-solaris); color: var(--solaris-11); }
  .badge.running { background: var(--bg-apple); color: var(--apple-11); }
  .badge.planning { background: var(--bg-lilac); color: var(--lilac-11); }
  .badge.building_graph { background: var(--bg-lilac); color: var(--lilac-11); }
  .badge.executing { background: var(--bg-apple); color: var(--apple-11); animation: pulse 1.5s infinite; }
  .badge.cancelled { background: var(--bg-smoke); color: var(--sd9); }

  .phase-bar {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--sd3); border-radius: var(--r-md); margin-bottom: 8px; font-size: 12px;
  }
  .phase-bar .phase-label { color: var(--sd9); }

  .toolbar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--sda7);
    color: var(--sd9); font-size: var(--fs-xs); text-transform: uppercase;
    font-weight: var(--fw-medium); letter-spacing: 0.3px;
  }
  td { padding: 6px 8px; border-bottom: 1px solid var(--sda5); }

  .output-box {
    background: var(--sd1); border: 1px solid var(--sda7); border-radius: var(--r-md);
    padding: 12px; max-height: 400px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-all; font-size: var(--fs-sm); line-height: 1.5;
    color: var(--sd9); font-family: var(--font-mono);
  }

  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(13,10,10,0.7); backdrop-filter: blur(4px);
    z-index: 100; align-items: center; justify-content: center;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--sd2); border: 1px solid var(--sda7);
    border-radius: var(--r-xl); padding: 20px; width: 500px; max-width: 90vw;
    box-shadow: var(--shadow-lg);
  }
  .modal h2 { margin-bottom: 16px; font-size: 15px; color: var(--sd12); }
  .modal label { display: block; margin-bottom: 4px; font-size: var(--fs-xs); color: var(--sd9); font-weight: var(--fw-medium); }
  .modal .field { margin-bottom: 12px; }
  .modal .field input, .modal .field textarea { width: 100%; }
  .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

  .empty { color: var(--sd8); font-style: italic; padding: 20px; text-align: center; }

  /* --- Canvas DAG --- */
  .canvas-container { position: relative; width: 100%; overflow: auto; background: var(--sd1); border: 1px solid var(--sda7); border-radius: var(--r-lg); }
  .canvas-container svg { display: block; }
  .dag-node { cursor: pointer; }
  .dag-node rect { rx: 6; ry: 6; stroke-width: 1.5; }
  .dag-node text { font-family: var(--font-sans); fill: var(--sd11); }
  .dag-node .node-title { font-size: 11px; font-weight: var(--fw-semi); }
  .dag-node .node-kind { font-size: 9px; fill: var(--sd9); }
  .dag-node .node-status { font-size: 9px; font-weight: var(--fw-semi); }
  .dag-edge { stroke: var(--sd5); stroke-width: 1.5; fill: none; }
  .dag-edge.completed { stroke: rgba(55,219,46,0.4); }
  .dag-arrowhead { fill: var(--sd5); }
  .dag-arrowhead.completed { fill: rgba(55,219,46,0.4); }

  /* --- Team message threads --- */
  .team-thread { margin-bottom: 16px; }
  .team-thread-header { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--sda5); margin-bottom: 8px; }
  .team-thread-header .team-name { font-size: var(--fs-base); font-weight: var(--fw-semi); color: var(--cobalt-11); }
  .team-thread-header .team-badge { font-size: var(--fs-xs); }
  .msg-list { display: flex; flex-direction: column; gap: 6px; max-height: 400px; overflow-y: auto; padding: 4px 0; }
  .msg-bubble { display: flex; gap: 8px; padding: 6px 0; }
  .msg-avatar {
    width: 28px; height: 28px; border-radius: 50%; background: var(--sd3);
    display: flex; align-items: center; justify-content: center;
    font-size: var(--fs-xs); font-weight: 700; color: var(--sd9);
    flex-shrink: 0; text-transform: uppercase;
  }
  .msg-avatar.orchestrator { background: var(--bg-lilac); color: var(--lilac-11); }
  .msg-avatar.user { background: var(--bg-cobalt); color: var(--cobalt-11); }
  .msg-avatar.agent { background: var(--bg-apple); color: var(--apple-11); }
  .msg-body { flex: 1; min-width: 0; }
  .msg-sender { font-size: var(--fs-sm); font-weight: var(--fw-semi); color: var(--sd12); margin-bottom: 2px; }
  .msg-sender .msg-time { font-weight: var(--fw-regular); color: var(--sd8); margin-left: 8px; font-size: var(--fs-xs); }
  .msg-sender .msg-type-tag { font-weight: var(--fw-regular); color: var(--sd9); margin-left: 6px; font-size: 9px; padding: 1px 5px; background: var(--sd3); border-radius: var(--r-xs); }
  .msg-content { font-size: 12px; color: var(--sd11); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  /* Node detail tooltip/panel */
  .node-detail-popup {
    position: fixed; z-index: 50; background: var(--sd2);
    border: 1px solid var(--sda7); border-radius: var(--r-lg);
    padding: 16px; width: 350px; box-shadow: var(--shadow-lg);
  }
  .node-detail-popup .close-btn { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--sd9); cursor: pointer; font-size: 14px; padding: 2px 6px; }
  .node-detail-popup .close-btn:hover { color: var(--sd12); }

  /* Tab bar */
  .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--sda5); margin-bottom: 12px; }
  .tab-bar button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--sd9); padding: 8px 14px; font-size: 12px; }
  .tab-bar button:hover { color: var(--sd11); }
  .tab-bar button.active { color: var(--cobalt-11); border-bottom-color: var(--cobalt-11); }

  /* === Universal Agent Output Renderer === */
  .agent-output { background: var(--sd1); border: 1px solid var(--sda7); border-radius: var(--r-lg); max-height: 600px; overflow-y: auto; }
  .agent-output .ao-block { padding: 10px 14px; border-bottom: 1px solid var(--sda3); }
  .agent-output .ao-block:last-child { border-bottom: none; }

  /* Text block — rendered markdown */
  .ao-text { font-size: 12px; line-height: 1.6; color: var(--sd11); }
  .ao-text p { margin: 4px 0; }
  .ao-text strong { color: var(--sd12); }
  .ao-text em { color: var(--sd9); font-style: italic; }
  .ao-text a { color: var(--cobalt-11); text-decoration: none; }
  .ao-text a:hover { text-decoration: underline; }
  .ao-text ul, .ao-text ol { margin: 4px 0 4px 20px; }
  .ao-text li { margin: 2px 0; }
  .ao-text h1,.ao-text h2,.ao-text h3,.ao-text h4 { color: var(--sd12); margin: 8px 0 4px; }
  .ao-text h1 { font-size: var(--fs-lg); } .ao-text h2 { font-size: var(--fs-md); } .ao-text h3 { font-size: var(--fs-base); }
  .ao-text blockquote { border-left: 3px solid var(--sd5); padding-left: 10px; color: var(--sd9); margin: 4px 0; }
  .ao-text hr { border: none; border-top: 1px solid var(--sda5); margin: 8px 0; }
  .ao-text table { border-collapse: collapse; margin: 6px 0; font-size: var(--fs-sm); }
  .ao-text table th, .ao-text table td { border: 1px solid var(--sda7); padding: 4px 8px; }
  .ao-text table th { background: var(--sd2); color: var(--sd9); }

  /* Inline code */
  .ao-text code { font-family: var(--font-mono); background: var(--sd3); padding: 1px 5px; border-radius: var(--r-xs); font-size: var(--fs-sm); color: var(--syn-prim); }

  /* Code block */
  .ao-code-block { position: relative; margin: 6px 0; border-radius: var(--r-md); overflow: hidden; border: 1px solid var(--sda6); }
  .ao-code-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; background: var(--sd2); border-bottom: 1px solid var(--sda5); font-size: var(--fs-xs); color: var(--sd9); }
  .ao-code-header .lang { text-transform: uppercase; font-weight: var(--fw-semi); letter-spacing: 0.5px; }
  .ao-code-header .copy-btn { background: none; border: none; color: var(--sd9); cursor: pointer; font-size: var(--fs-xs); padding: 2px 6px; }
  .ao-code-header .copy-btn:hover { color: var(--sd12); }
  .ao-code-body { font-family: var(--font-mono); padding: 10px 12px; overflow-x: auto; font-size: var(--fs-sm); line-height: 1.5; background: var(--sd1); color: var(--sd11); }
  .ao-code-body pre { margin: 0; white-space: pre; font-family: inherit; }

  /* Syntax colors (matching app dark theme) */
  .ao-code-body .kw { color: var(--syn-kw); }
  .ao-code-body .str { color: var(--syn-str); }
  .ao-code-body .num { color: var(--syn-num); }
  .ao-code-body .cm { color: var(--syn-cm); font-style: italic; }
  .ao-code-body .fn { color: var(--syn-fn); }
  .ao-code-body .op { color: var(--syn-op); }
  .ao-code-body .type { color: var(--syn-type); }

  /* Thinking block (collapsible) */
  .ao-thinking { border-left: 3px solid var(--lilac-9); background: rgba(236,112,251,0.03); }
  .ao-thinking-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 6px 10px; font-size: var(--fs-sm); color: var(--lilac-11); }
  .ao-thinking-toggle:hover { background: rgba(236,112,251,0.06); }
  .ao-thinking-toggle .arrow { transition: transform 0.2s; display: inline-block; }
  .ao-thinking-toggle .arrow.open { transform: rotate(90deg); }
  .ao-thinking-body { font-family: var(--font-mono); padding: 8px 14px; font-size: var(--fs-sm); color: var(--sd9); line-height: 1.5; white-space: pre-wrap; word-break: break-word; display: none; max-height: 300px; overflow-y: auto; }
  .ao-thinking-body.open { display: block; }

  /* Tool call card */
  .ao-tool { border: 1px solid var(--sda6); border-radius: var(--r-md); overflow: hidden; margin: 4px 0; }
  .ao-tool-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--sd2); cursor: pointer; user-select: none; transition: background 0.12s ease; }
  .ao-tool-header:hover { background: var(--sd3); }
  .ao-tool-icon { width: 20px; height: 20px; border-radius: var(--r-sm); display: flex; align-items: center; justify-content: center; font-size: var(--fs-xs); font-weight: 700; font-family: var(--font-mono); }
  .ao-tool-icon.read { background: var(--bg-cobalt); color: var(--cobalt-11); }
  .ao-tool-icon.edit { background: var(--bg-solaris); color: var(--solaris-11); }
  .ao-tool-icon.write { background: var(--bg-apple); color: var(--apple-11); }
  .ao-tool-icon.bash { background: var(--bg-ember); color: var(--ember-11); }
  .ao-tool-icon.search { background: var(--bg-lilac); color: var(--lilac-11); }
  .ao-tool-icon.other { background: var(--sd3); color: var(--sd9); }
  .ao-tool-name { font-size: 12px; font-weight: var(--fw-semi); color: var(--sd12); }
  .ao-tool-file { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--sd9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .ao-tool-status { font-size: var(--fs-xs); margin-left: auto; }
  .ao-tool-status.running { color: var(--apple-11); }
  .ao-tool-status.done { color: var(--sd9); }
  .ao-tool-body { display: none; border-top: 1px solid var(--sda5); padding: 10px 12px; font-size: var(--fs-sm); background: var(--sd1); max-height: 300px; overflow-y: auto; font-family: var(--font-mono); }
  .ao-tool-body.open { display: block; }

  /* Diff view */
  .ao-diff { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; white-space: pre; overflow-x: auto; }
  .ao-diff .diff-add { color: var(--apple-11); background: rgba(51,255,34,0.06); }
  .ao-diff .diff-del { color: var(--ember-11); background: rgba(251,34,0,0.06); }
  .ao-diff .diff-hunk { color: var(--lilac-11); }

  /* Result block */
  .ao-result { border-top: 2px solid var(--sda6); padding: 10px 14px; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .ao-result.success { border-top-color: var(--apple-dim); }
  .ao-result.error { border-top-color: var(--ember-dim); }
  .ao-result .result-icon { font-size: 14px; }

  /* Plan block */
  .ao-plan { padding: 10px 14px; }
  .ao-plan-item { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 12px; }
  .ao-plan-check { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--sd5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; font-size: 9px; }
  .ao-plan-check.completed { background: var(--apple-dim); border-color: var(--apple-11); color: var(--apple-11); }
  .ao-plan-check.in_progress { border-color: var(--apple-11); color: var(--apple-11); animation: pulse 1.5s infinite; }
  .ao-plan-check.pending { border-color: var(--sd5); }
  .ao-plan-check.failed { background: var(--ember-dim); border-color: var(--ember-9); color: var(--ember-11); }

  /* System/status message */
  .ao-status { font-size: var(--fs-sm); color: var(--sd9); padding: 4px 14px; font-style: italic; display: flex; align-items: center; gap: 6px; }
  .ao-status .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--apple-11); animation: pulse 1.5s infinite; }
</style>
</head>
<body>

<div class="header">
  <h1>Orchestrator Dashboard</h1>
  <div style="display:flex;gap:8px;">
    <button onclick="refreshAll()">Refresh</button>
    <button class="primary" onclick="openSpawnModal()">Spawn Agent</button>
  </div>
</div>

<div class="container">
  <div class="sidebar">
    <div class="section">
      <h3>Orchestrate</h3>
      <div class="create-row">
        <input id="newRunGoal" placeholder="Goal..." onkeydown="if(event.key==='Enter')orchestrateGoal()">
        <button class="primary" onclick="orchestrateGoal()">Go</button>
      </div>
      <div style="margin-top:4px;">
        <button style="width:100%;font-size:11px;" onclick="createRun()">Manual Run (no AI)</button>
      </div>
    </div>

    <div class="section">
      <h3>Runs</h3>
      <div id="runsList"><div class="empty">No runs yet</div></div>
    </div>

    <div class="section">
      <h3>Agents</h3>
      <div id="agentsList"><div class="empty">No agents</div></div>
    </div>
  </div>

  <div class="main" id="mainPanel">
    <div class="empty">Select a run or agent from the sidebar</div>
  </div>
</div>

<!-- Spawn Agent Modal -->
<div class="modal-overlay" id="spawnModal">
  <div class="modal">
    <h2>Spawn Claude Agent</h2>
    <div class="field">
      <label>Prompt *</label>
      <textarea id="spawnPrompt" rows="4" placeholder="What should the agent do?"></textarea>
    </div>
    <div class="field">
      <label>Working Directory (optional)</label>
      <input id="spawnCwd" placeholder="Defaults to server cwd">
    </div>
    <div class="field">
      <label>Run ID (optional)</label>
      <input id="spawnRunId" placeholder="Link to a run">
    </div>
    <div class="field">
      <label>Node ID (optional)</label>
      <input id="spawnNodeId" placeholder="Link to a node">
    </div>
    <div class="actions">
      <button onclick="closeSpawnModal()">Cancel</button>
      <button class="primary" onclick="spawnAgent()">Spawn</button>
    </div>
  </div>
</div>

<!-- Node detail popup -->
<div class="node-detail-popup" id="nodeDetailPopup" style="display:none;">
  <button class="close-btn" onclick="closeNodeDetail()">&times;</button>
  <div id="nodeDetailContent"></div>
</div>

<script>
const BASE = '';
let selectedRun = null;
let selectedAgent = null;
let agentEventSources = {};
let currentRunData = null;

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  return res.json();
}

// ════════════════════════════════════════════════════════
// Universal Agent Output Renderer
// Parses Claude stream-json & ACP session updates into
// a common block model, then renders rich UI.
//
// Inspired by AionUI's TMessage discriminated union:
//   agent_message_chunk → text block
//   tool_call           → tool card with diffs
//   plan                → checklist
//   thinking            → collapsible reasoning
// ════════════════════════════════════════════════════════

class AgentOutputRenderer {
  constructor(containerEl) {
    this.el = containerEl;
    this.blocks = [];       // { type, id, ... } — the universal model
    this.blockIndex = {};   // id → block for O(1) lookup (like AionUI's msgIdIndex)
    this.lineBuffer = '';   // accumulates partial lines from stream
    this.toolInputBuffers = {}; // tool_use id → partial JSON string
  }

  // ── Parse one raw text chunk from the SSE stream ──
  ingestChunk(rawText) {
    this.lineBuffer += rawText;
    const lines = this.lineBuffer.split('\\n');
    // Keep the last partial line in the buffer
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        this._processStreamJsonEvent(obj);
      } catch {
        // Not JSON — treat as plain text
        this._appendText(trimmed);
      }
    }
    this._render();
  }

  // ── Process a single stream-json event from Claude CLI ──
  _processStreamJsonEvent(evt) {
    switch (evt.type) {
      case 'system':
        this._addBlock({ type: 'status', id: 'sys_' + Date.now(), text: evt.message || evt.subtype || 'System' });
        break;

      case 'assistant':
        // Start of assistant turn — we'll get content_block events next
        break;

      case 'content_block_start': {
        const cb = evt.content_block;
        if (!cb) break;
        const idx = evt.index ?? this.blocks.length;
        if (cb.type === 'thinking') {
          this._addBlock({ type: 'thinking', id: 'think_' + idx, text: cb.thinking || '' });
        } else if (cb.type === 'text') {
          this._addBlock({ type: 'text', id: 'text_' + idx, text: cb.text || '' });
        } else if (cb.type === 'tool_use') {
          this.toolInputBuffers[cb.id] = '';
          this._addBlock({
            type: 'tool_call', id: cb.id,
            name: cb.name || 'Tool',
            input: {},
            status: 'running',
            output: null
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = evt.delta;
        if (!delta) break;
        const idx = evt.index ?? 0;

        if (delta.type === 'thinking_delta') {
          const block = this._findBlockByPrefix('think_' + idx);
          if (block) block.text += delta.thinking || '';
        } else if (delta.type === 'text_delta') {
          const block = this._findBlockByPrefix('text_' + idx);
          if (block) block.text += delta.text || '';
        } else if (delta.type === 'input_json_delta') {
          // Accumulate partial JSON for tool input
          const toolBlock = this._findLatestToolBlock();
          if (toolBlock && this.toolInputBuffers[toolBlock.id] !== undefined) {
            this.toolInputBuffers[toolBlock.id] += delta.partial_json || '';
          }
        }
        break;
      }

      case 'content_block_stop': {
        const idx = evt.index ?? 0;
        // Finalize tool input JSON
        const toolBlock = this._findLatestToolBlock();
        if (toolBlock && toolBlock.status === 'running' && this.toolInputBuffers[toolBlock.id]) {
          try {
            toolBlock.input = JSON.parse(this.toolInputBuffers[toolBlock.id]);
          } catch {
            toolBlock.input = { raw: this.toolInputBuffers[toolBlock.id] };
          }
        }
        break;
      }

      case 'result': {
        const isError = evt.is_error || evt.subtype === 'error';
        // Try to parse result text
        let resultText = '';
        if (typeof evt.result === 'string') {
          resultText = evt.result;
        } else if (evt.result?.text) {
          resultText = evt.result.text;
        } else if (evt.result) {
          resultText = JSON.stringify(evt.result);
        }

        // Mark all running tools as done
        for (const b of this.blocks) {
          if (b.type === 'tool_call' && b.status === 'running') b.status = 'done';
        }

        if (resultText || isError) {
          this._addBlock({
            type: 'result', id: 'result_' + Date.now(),
            text: resultText.slice(0, 2000),
            isError: isError,
            durationMs: evt.duration_ms,
            numTurns: evt.num_turns
          });
        }
        break;
      }

      // ACP session update types (from AionUI pattern)
      case 'agent_message_chunk':
      case 'session_update': {
        const update = evt.update || evt;
        if (update.sessionUpdate === 'agent_message_chunk' || update.content) {
          const content = update.content || {};
          if (content.type === 'text' || content.text) {
            this._appendText(content.text || '');
          }
        } else if (update.sessionUpdate === 'tool_call') {
          this._processAcpToolCall(update);
        } else if (update.sessionUpdate === 'plan') {
          this._processAcpPlan(update);
        }
        break;
      }

      default:
        // Unknown event type — show as status if it has useful info
        if (evt.subtype === 'tool_result' || evt.type === 'tool_result') {
          // Tool result from Claude
          const toolBlock = this._findLatestToolBlock();
          if (toolBlock) {
            toolBlock.status = 'done';
            if (evt.content) {
              toolBlock.output = typeof evt.content === 'string'
                ? evt.content
                : JSON.stringify(evt.content, null, 2);
            }
          }
        }
        break;
    }
  }

  // ── ACP tool_call update (AionUI pattern) ──
  _processAcpToolCall(update) {
    const id = update.toolCallId || ('acp_tool_' + Date.now());
    let block = this.blockIndex[id];
    if (!block) {
      block = {
        type: 'tool_call', id,
        name: update.title || 'Tool',
        input: update.rawInput || {},
        status: update.status === 'completed' ? 'done' : 'running',
        output: null,
        kind: update.kind || 'other'
      };
      this._addBlock(block);
    } else {
      if (update.status === 'completed' || update.status === 'failed') block.status = 'done';
      if (update.title) block.name = update.title;
      if (update.content) {
        block.output = update.content.map(c => {
          if (c.type === 'diff') return '--- ' + (c.path||'') + '\\n' + formatDiff(c.oldText, c.newText);
          return c.content?.text || '';
        }).join('\\n');
      }
    }
  }

  // ── ACP plan update (AionUI pattern) ──
  _processAcpPlan(update) {
    const entries = update.entries || [];
    // Find existing plan block or create one
    let planBlock = this.blocks.find(b => b.type === 'plan');
    if (!planBlock) {
      planBlock = { type: 'plan', id: 'plan_' + Date.now(), entries: [] };
      this._addBlock(planBlock);
    }
    planBlock.entries = entries.map(e => ({
      content: e.content || '',
      status: e.status || 'pending'
    }));
  }

  // ── Helpers ──
  _appendText(text) {
    // Merge into last text block if available
    const lastTextBlock = [...this.blocks].reverse().find(b => b.type === 'text');
    if (lastTextBlock) {
      lastTextBlock.text += text;
    } else {
      this._addBlock({ type: 'text', id: 'text_' + Date.now(), text });
    }
  }

  _addBlock(block) {
    this.blocks.push(block);
    this.blockIndex[block.id] = block;
  }

  _findBlockByPrefix(prefix) {
    return this.blockIndex[prefix] || this.blocks.find(b => b.id === prefix);
  }

  _findLatestToolBlock() {
    return [...this.blocks].reverse().find(b => b.type === 'tool_call');
  }

  // ── Render all blocks to DOM ──
  _render() {
    let html = '';
    for (const block of this.blocks) {
      switch (block.type) {
        case 'text':
          html += '<div class="ao-block"><div class="ao-text">' + renderMarkdown(block.text) + '</div></div>';
          break;

        case 'thinking':
          html += '<div class="ao-block ao-thinking">'
            + '<div class="ao-thinking-toggle" onclick="toggleThinking(this)">'
            + '<span class="arrow">&#9654;</span> Thinking (' + block.text.length + ' chars)'
            + '</div>'
            + '<div class="ao-thinking-body">' + esc(block.text) + '</div>'
            + '</div>';
          break;

        case 'tool_call':
          html += renderToolCallBlock(block);
          break;

        case 'plan':
          html += renderPlanBlock(block);
          break;

        case 'result':
          html += '<div class="ao-block ao-result ' + (block.isError ? 'error' : 'success') + '">'
            + '<span class="result-icon">' + (block.isError ? '&#10060;' : '&#9989;') + '</span>'
            + '<span>' + (block.isError ? 'Error' : 'Completed')
            + (block.durationMs ? ' in ' + (block.durationMs / 1000).toFixed(1) + 's' : '')
            + (block.numTurns ? ' (' + block.numTurns + ' turns)' : '')
            + '</span>'
            + '</div>';
          if (block.text) {
            html += '<div class="ao-block"><div class="ao-text">' + renderMarkdown(block.text) + '</div></div>';
          }
          break;

        case 'status':
          html += '<div class="ao-block ao-status">'
            + '<div class="status-dot"></div>'
            + esc(block.text)
            + '</div>';
          break;
      }
    }

    if (!html && this.blocks.length === 0) {
      html = '<div class="ao-block ao-status"><div class="status-dot"></div>Waiting for output...</div>';
    }

    this.el.innerHTML = html;
    this.el.scrollTop = this.el.scrollHeight;
  }

  // ── Mark as finished ──
  finish(status, exitCode) {
    if (status === 'completed' && !this.blocks.find(b => b.type === 'result')) {
      this._addBlock({ type: 'result', id: 'final', text: '', isError: false });
    } else if (status === 'failed' && !this.blocks.find(b => b.type === 'result')) {
      this._addBlock({ type: 'result', id: 'final', text: 'Exit code: ' + exitCode, isError: true });
    }
    // Mark all running tools as done
    for (const b of this.blocks) {
      if (b.type === 'tool_call' && b.status === 'running') b.status = 'done';
    }
    this._render();
  }
}

// ── Collapsible toggles ──
function toggleThinking(el) {
  const body = el.nextElementSibling;
  const arrow = el.querySelector('.arrow');
  body.classList.toggle('open');
  arrow.classList.toggle('open');
}

function toggleToolBody(el) {
  const body = el.nextElementSibling;
  body.classList.toggle('open');
}

// ── Render a tool call block ──
function renderToolCallBlock(block) {
  const name = block.name || 'Tool';
  const kind = classifyTool(name);
  const statusClass = block.status === 'running' ? 'running' : 'done';
  const statusText = block.status === 'running' ? '&#9679; running' : '&#10003; done';
  const file = extractFilePath(block.input) || '';

  let bodyContent = '';
  // Show input
  if (block.input && Object.keys(block.input).length > 0) {
    if (block.input.command) {
      bodyContent += '<div style="margin-bottom:6px;"><span style="color:#716c6b;">$</span> <span style="color:#b7b1b1;">' + esc(block.input.command) + '</span></div>';
    }
    if (block.input.old_string !== undefined && block.input.new_string !== undefined) {
      bodyContent += '<div class="ao-diff">' + renderSimpleDiff(block.input.old_string, block.input.new_string) + '</div>';
    } else if (block.input.content) {
      bodyContent += '<div style="color:#b7b1b1;white-space:pre-wrap;max-height:200px;overflow-y:auto;">' + esc(typeof block.input.content === 'string' ? block.input.content : JSON.stringify(block.input.content, null, 2)) + '</div>';
    } else if (!block.input.command && !block.input.raw) {
      const inputStr = JSON.stringify(block.input, null, 2);
      if (inputStr.length > 5 && inputStr !== '{}') {
        bodyContent += '<div style="color:#716c6b;white-space:pre-wrap;max-height:200px;overflow-y:auto;">' + esc(inputStr) + '</div>';
      }
    }
  }
  // Show output
  if (block.output) {
    bodyContent += '<div style="margin-top:8px;border-top:1px solid rgba(245,232,232,0.15);padding-top:6px;color:#716c6b;white-space:pre-wrap;max-height:200px;overflow-y:auto;">' + esc(block.output.slice(0, 3000)) + '</div>';
  }

  return '<div class="ao-block"><div class="ao-tool">'
    + '<div class="ao-tool-header" onclick="toggleToolBody(this)">'
    + '<div class="ao-tool-icon ' + kind + '">' + toolIcon(kind) + '</div>'
    + '<span class="ao-tool-name">' + esc(name) + '</span>'
    + '<span class="ao-tool-file">' + esc(file) + '</span>'
    + '<span class="ao-tool-status ' + statusClass + '">' + statusText + '</span>'
    + '</div>'
    + '<div class="ao-tool-body">' + (bodyContent || '<span style="color:#645f5f;">No details</span>') + '</div>'
    + '</div></div>';
}

function classifyTool(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return 'read';
  if (n.includes('edit')) return 'edit';
  if (n.includes('write')) return 'write';
  if (n.includes('bash') || n.includes('execute') || n.includes('command')) return 'bash';
  if (n.includes('search') || n.includes('web')) return 'search';
  return 'other';
}

function toolIcon(kind) {
  switch (kind) {
    case 'read': return 'R';
    case 'edit': return 'E';
    case 'write': return 'W';
    case 'bash': return '$';
    case 'search': return '?';
    default: return 'T';
  }
}

function extractFilePath(input) {
  if (!input) return '';
  return input.file_path || input.path || input.file || input.pattern || '';
}

// ── Simple diff renderer ──
function renderSimpleDiff(oldStr, newStr) {
  if (!oldStr && !newStr) return '';
  const oldLines = (oldStr || '').split('\\n');
  const newLines = (newStr || '').split('\\n');
  let html = '';

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0, ni = 0;

  // Removed lines
  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      html += '<div class="diff-del">- ' + esc(line) + '</div>';
    }
  }
  // Added lines
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      html += '<div class="diff-add">+ ' + esc(line) + '</div>';
    }
  }

  if (!html) html = '<div style="color:#716c6b;">(no changes)</div>';
  return html;
}

// ── Render a plan block ──
function renderPlanBlock(block) {
  if (!block.entries || !block.entries.length) return '';
  let html = '<div class="ao-block ao-plan">';
  for (const entry of block.entries) {
    const checkClass = entry.status || 'pending';
    const checkMark = entry.status === 'completed' ? '&#10003;'
      : entry.status === 'in_progress' ? '&#9679;'
      : entry.status === 'failed' ? '&#10060;' : '';
    html += '<div class="ao-plan-item">'
      + '<div class="ao-plan-check ' + checkClass + '">' + checkMark + '</div>'
      + '<div style="color:#b7b1b1;">' + esc(entry.content) + '</div>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

// ── Lightweight Markdown renderer ──
function renderMarkdown(text) {
  if (!text) return '';
  let s = esc(text);

  // Code blocks: \`\`\`lang\\n...\\n\`\`\`
  s = s.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
    const langLabel = lang || 'code';
    const highlighted = highlightSyntax(code, lang);
    return '<div class="ao-code-block"><div class="ao-code-header"><span class="lang">' + esc(langLabel)
      + '</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'
      + '<div class="ao-code-body"><pre>' + highlighted + '</pre></div></div>';
  });

  // Inline code
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

  // Bold
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

  // Italic
  s = s.replace(/(?<![*])\\*(?![*])(.+?)(?<![*])\\*(?![*])/g, '<em>$1</em>');

  // Headers
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rule
  s = s.replace(/^---$/gm, '<hr>');

  // Unordered lists
  s = s.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>');
  // Deduplicate nested <ul> wrapping
  s = s.replace(/<\\/ul>\\s*<ul>/g, '');

  // Links
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');

  // Paragraphs (double newlines)
  s = s.replace(/\\n\\n/g, '</p><p>');
  // Remaining single newlines to <br> (only outside code blocks and lists)
  s = s.replace(/\\n/g, '<br>');

  return '<p>' + s + '</p>';
}

// ── Simplified syntax highlighter ──
function highlightSyntax(code, lang) {
  let s = code; // already escaped

  // Comments (single-line)
  s = s.replace(/((?:^|\\n)\\s*)((?:\\/\\/|#).*)$/gm, '$1<span class="cm">$2</span>');

  // Strings (double/single quoted)
  s = s.replace(/(&quot;[^&]*?&quot;)/g, '<span class="str">$1</span>');
  s = s.replace(/(&#039;[^&]*?&#039;)/g, '<span class="str">$1</span>');
  // Template string backticks
  s = s.replace(/(\`[^\`]*?\`)/g, '<span class="str">$1</span>');

  // Numbers
  s = s.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="num">$1</span>');

  // Keywords
  const kwPattern = /\\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|super|extends|implements|interface|type|enum|public|private|static|readonly|def|print|self|True|False|None|fn|pub|mod|use|struct|impl|match|where|select|insert|update|delete|create|table|values|set)\\b/g;
  s = s.replace(kwPattern, '<span class="kw">$1</span>');

  // Type-like words (capitalized)
  s = s.replace(/\\b([A-Z][a-zA-Z]+)\\b/g, '<span class="type">$1</span>');

  // Function calls
  s = s.replace(/\\b([a-zA-Z_]\\w*)\\s*\\(/g, '<span class="fn">$1</span>(');

  // Operators
  s = s.replace(/(=&gt;|===|!==|==|!=|&amp;&amp;|\\|\\||&lt;=|&gt;=)/g, '<span class="op">$1</span>');

  return s;
}

function copyCode(btn) {
  const pre = btn.closest('.ao-code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent);
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

// Global renderer instances per agent
const renderers = {};

// ═══════════════════════════════════════
// ── Runs ──
// ═══════════════════════════════════════

async function loadRuns() {
  const runs = await api('/runs');
  const el = document.getElementById('runsList');
  if (!runs.length) { el.innerHTML = '<div class="empty">No runs yet</div>'; return; }
  el.innerHTML = runs.map(r => \`
    <div class="item \${selectedRun === r.run_id ? 'selected' : ''}" onclick="selectRun('\${r.run_id}')">
      <div class="dot \${r.status}"></div>
      <div class="label">\${esc(r.goal)}</div>
      <div class="meta">\${r.status}</div>
    </div>
  \`).join('');
}

async function orchestrateGoal() {
  const input = document.getElementById('newRunGoal');
  const goal = input.value.trim();
  if (!goal) return;
  const result = await api('/orchestrate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({goal}) });
  input.value = '';
  await loadRuns();
  if (result.run_id) selectRun(result.run_id);
}

async function cancelOrchestration(runId) {
  await api('/orchestrate/' + runId + '/cancel', { method: 'POST' });
  if (selectedRun === runId) await renderRunDetail(runId);
}

async function createRun() {
  const input = document.getElementById('newRunGoal');
  const goal = input.value.trim();
  if (!goal) return;
  await api('/runs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({goal}) });
  input.value = '';
  await loadRuns();
}

async function selectRun(runId) {
  selectedRun = runId;
  selectedAgent = null;
  await loadRuns();
  await renderRunDetail(runId);
}

async function renderRunDetail(runId) {
  const [run, teams, nodes, messages, edges, events] = await Promise.all([
    api('/runs/' + runId),
    api('/runs/' + runId + '/teams'),
    api('/runs/' + runId + '/nodes'),
    api('/runs/' + runId + '/messages'),
    api('/runs/' + runId + '/edges'),
    api('/runs/' + runId + '/events'),
  ]);

  currentRunData = { run, teams, nodes, messages, edges, events };

  let orch = null;
  try {
    const orchRes = await fetch(BASE + '/orchestrate/' + runId);
    if (orchRes.ok) orch = await orchRes.json();
  } catch(_) {}

  const phaseHtml = orch ? \`
    <div class="phase-bar">
      <span class="phase-label">Phase:</span>
      <span class="badge \${orch.phase}">\${orch.phase.replace('_', ' ')}</span>
      \${orch.plan_summary ? '<span style="color:#716c6b;margin-left:8px;">' + esc(orch.plan_summary) + '</span>' : ''}
      \${orch.error ? '<span style="color:#ff917b;margin-left:8px;">' + esc(orch.error) + '</span>' : ''}
      \${orch.phase === 'planning' || orch.phase === 'executing' || orch.phase === 'building_graph' ?
        '<button class="danger" style="margin-left:auto;" onclick="cancelOrchestration(\\'' + runId + '\\')">Cancel</button>' : ''}
    </div>
    \${orch.nodes_by_status ? \`<div style="font-size:11px;color:#716c6b;margin-bottom:8px;">
      Nodes: \${orch.nodes_by_status.completed}/\${orch.node_count} completed,
      \${orch.nodes_by_status.active} active,
      \${orch.nodes_by_status.pending} pending,
      \${orch.nodes_by_status.failed} failed
    </div>\` : ''}
  \` : '';

  // Result panel (Gap 3): shown when run is completed
  const finalResultMsg = messages.find(m => m.message_type === 'final_result');
  const resultPanelHtml = (run.status === 'completed' && (orch?.result || finalResultMsg)) ? \`
    <div class="panel" style="border-color:rgba(51,255,34,0.25);">
      <h2 style="color:#37db2e;">Result</h2>
      <div class="agent-output" style="max-height:600px;">
        <div class="ao-block ao-result success"><span class="result-icon">&#9989;</span><span>Run Completed</span></div>
        <div class="ao-block"><div class="ao-text">\${renderMarkdown((finalResultMsg?.content || orch?.result || '').slice(0, 10000))}</div></div>
      </div>
    </div>
  \` : '';

  const panel = document.getElementById('mainPanel');
  panel.innerHTML = \`
    \${resultPanelHtml}
    <div class="panel">
      <h2>Run: \${esc(run.goal)}</h2>
      \${phaseHtml}
      <div class="kv">
        <div class="k">ID</div><div class="v">\${run.run_id}</div>
        <div class="k">Status</div><div class="v"><span class="badge \${run.status}">\${run.status}</span></div>
      </div>
      <div class="toolbar">
        <button onclick="showAddTeam('\${runId}')">+ Team</button>
        <button onclick="showAddNode('\${runId}')">+ Node</button>
        <button onclick="showAddMessage('\${runId}')">+ Message</button>
        <button onclick="showAddEdge('\${runId}')">+ Edge</button>
      </div>
      <div id="inlineForm"></div>
    </div>

    <div class="panel">
      <h2>Task Graph (\${nodes.length} nodes)</h2>
      <div class="tab-bar" id="graphTabBar">
        <button class="active" onclick="showGraphTab('canvas')">Canvas</button>
        <button onclick="showGraphTab('table')">Table</button>
      </div>
      <div id="graphCanvas">\${renderCanvas(nodes, edges, teams)}</div>
      <div id="graphTable" style="display:none;">
        \${renderNodesTable(nodes, runId)}
      </div>
    </div>

    <div class="panel">
      <h2>Teams (\${teams.length})</h2>
      \${teams.length ? \`<table><tr><th>ID</th><th>Name</th><th>Status</th></tr>
        \${teams.map(t => \`<tr><td>\${t.team_id}</td><td>\${esc(t.name)}</td><td><span class="badge \${t.status}">\${t.status}</span></td></tr>\`).join('')}
      </table>\` : '<div class="empty">No teams</div>'}
    </div>

    <div class="panel">
      <h2>Messages (\${messages.filter(m => m.message_type !== 'node_metadata').length})</h2>
      \${renderMessageThreads(messages, teams)}
    </div>

    <div class="panel">
      <h2>Events (\${events.length})</h2>
      \${events.length ? \`<table><tr><th>Seq</th><th>Type</th><th>Actor</th><th>Time</th></tr>
        \${events.map(e => \`<tr><td>\${e.stream_seq}</td><td>\${esc(e.type)}</td><td>\${esc(e.actor_id)}</td><td>\${e.created_at}</td></tr>\`).join('')}
      </table>\` : '<div class="empty">No events</div>'}
    </div>
  \`;
}

// ═══════════════════════════════════════
// ── Graph tab switching ──
// ═══════════════════════════════════════

function showGraphTab(tab) {
  const canvas = document.getElementById('graphCanvas');
  const table = document.getElementById('graphTable');
  const btns = document.querySelectorAll('#graphTabBar button');
  btns.forEach(b => b.classList.remove('active'));
  if (tab === 'canvas') { canvas.style.display = ''; table.style.display = 'none'; btns[0].classList.add('active'); }
  else { canvas.style.display = 'none'; table.style.display = ''; btns[1].classList.add('active'); }
}

function renderNodesTable(nodes, runId) {
  if (!nodes.length) return '<div class="empty">No nodes</div>';
  return \`<table><tr><th>ID</th><th>Title</th><th>Kind</th><th>Team</th><th>Status</th><th>Actions</th></tr>
    \${nodes.map(n => \`<tr>
      <td>\${n.node_id}</td><td>\${esc(n.title || '')}</td><td>\${esc(n.kind)}</td><td>\${n.team_id}</td>
      <td><span class="badge \${n.status}">\${n.status}</span></td>
      <td>
        \${n.status === 'pending' ? \`<button onclick="updateNode('\${runId}','\${n.node_id}','active')">Activate</button>\` : ''}
        \${n.status === 'active' ? \`<button onclick="updateNode('\${runId}','\${n.node_id}','completed')">Complete</button>\` : ''}
      </td>
    </tr>\`).join('')}
  </table>\`;
}

// ═══════════════════════════════════════
// ── SVG Canvas DAG (unchanged) ──
// ═══════════════════════════════════════

function renderCanvas(nodes, edges, teams) {
  if (!nodes.length) return '<div class="empty">No nodes to display</div>';
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.node_id] = n; });
  const inEdges = {}, outEdges = {};
  nodes.forEach(n => { inEdges[n.node_id] = []; outEdges[n.node_id] = []; });
  edges.forEach(e => {
    if (inEdges[e.target_id]) inEdges[e.target_id].push(e.source_id);
    if (outEdges[e.source_id]) outEdges[e.source_id].push(e.target_id);
  });
  const teamColors = {};
  const palette = ['#89b5ff','#dca2e0','#37db2e','#fdd63c','#ff917b','#93e9f6','#edb2f1','#aff7a8'];
  teams.forEach((t, i) => { teamColors[t.team_id] = palette[i % palette.length]; });
  const layers = {}, visited = new Set();
  function assignLayer(nodeId) {
    if (visited.has(nodeId)) return layers[nodeId] || 0;
    visited.add(nodeId);
    const deps = inEdges[nodeId] || [];
    if (deps.length === 0) { layers[nodeId] = 0; }
    else { let m = 0; for (const d of deps) { m = Math.max(m, assignLayer(d) + 1); } layers[nodeId] = m; }
    return layers[nodeId];
  }
  nodes.forEach(n => assignLayer(n.node_id));
  const layerGroups = {}; let maxLayer = 0;
  nodes.forEach(n => { const l = layers[n.node_id]; if (!layerGroups[l]) layerGroups[l] = []; layerGroups[l].push(n); if (l > maxLayer) maxLayer = l; });
  const nodeW = 180, nodeH = 54, hGap = 40, vGap = 30, padX = 30, padY = 30;
  const positions = {}; let maxWidth = 0;
  for (let l = 0; l <= maxLayer; l++) { const g = layerGroups[l] || []; const w = g.length * nodeW + (g.length - 1) * hGap; if (w > maxWidth) maxWidth = w; }
  for (let l = 0; l <= maxLayer; l++) { const g = layerGroups[l] || []; const w = g.length * nodeW + (g.length - 1) * hGap; const sx = padX + (maxWidth - w) / 2; const y = padY + l * (nodeH + vGap); g.forEach((n, i) => { positions[n.node_id] = { x: sx + i * (nodeW + hGap), y }; }); }
  const svgW = maxWidth + padX * 2, svgH = padY * 2 + (maxLayer + 1) * nodeH + maxLayer * vGap;
  const sf = { pending: 'rgba(254,187,0,0.11)', active: 'rgba(51,255,34,0.12)', completed: 'rgba(237,213,213,0.09)', failed: 'rgba(251,34,0,0.18)' };
  const ss = { pending: '#fdd63c', active: '#37db2e', completed: '#716c6b', failed: '#fc533a' };
  const sc = { pending: '#fdd63c', active: '#37db2e', completed: '#716c6b', failed: '#fc533a' };
  let svg = \`<div class="canvas-container"><svg width="\${Math.max(svgW, 300)}" height="\${Math.max(svgH, 100)}" viewBox="0 0 \${Math.max(svgW, 300)} \${Math.max(svgH, 100)}">\`;
  svg += '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" class="dag-arrowhead" /></marker><marker id="arrowhead-completed" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" class="dag-arrowhead completed" /></marker></defs>';
  edges.forEach(e => {
    const s = positions[e.source_id], t = positions[e.target_id]; if (!s || !t) return;
    const comp = nodeMap[e.source_id] && nodeMap[e.source_id].status === 'completed';
    const cls = comp ? 'dag-edge completed' : 'dag-edge';
    const mr = comp ? 'url(#arrowhead-completed)' : 'url(#arrowhead)';
    const x1 = s.x + nodeW/2, y1 = s.y + nodeH, x2 = t.x + nodeW/2, y2 = t.y, my = (y1+y2)/2;
    svg += \`<path d="M \${x1} \${y1} C \${x1} \${my}, \${x2} \${my}, \${x2} \${y2}" class="\${cls}" marker-end="\${mr}" />\`;
  });
  nodes.forEach(n => {
    const p = positions[n.node_id]; if (!p) return;
    const fill = sf[n.status]||sf.pending, stroke = ss[n.status]||ss.pending, stc = sc[n.status]||sc.pending;
    const tc = teamColors[n.team_id]||'#716c6b';
    const title = (n.title||n.kind||n.node_id).slice(0,22), kind = n.kind.slice(0,20);
    svg += \`<g class="dag-node" onclick="showNodeDetail(event, '\${n.node_id}')"><rect x="\${p.x}" y="\${p.y}" width="\${nodeW}" height="\${nodeH}" fill="\${fill}" stroke="\${stroke}" /><line x1="\${p.x}" y1="\${p.y}" x2="\${p.x}" y2="\${p.y + nodeH}" stroke="\${tc}" stroke-width="3" /><text x="\${p.x + 10}" y="\${p.y + 18}" class="node-title" style="font-family:Inter,sans-serif">\${escSvg(title)}</text><text x="\${p.x + 10}" y="\${p.y + 32}" class="node-kind" style="font-family:Inter,sans-serif">\${escSvg(kind)}</text><text x="\${p.x + 10}" y="\${p.y + 46}" class="node-status" fill="\${stc}" style="font-family:Inter,sans-serif">\${n.status}\${n.retry_count > 0 ? ' (retry ' + n.retry_count + ')' : ''}</text></g>\`;
  });
  svg += '</svg></div>';
  if (teams.length > 0) {
    svg += '<div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;font-size:11px;">';
    teams.forEach(t => { const c = teamColors[t.team_id]||'#716c6b'; svg += \`<span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:\${c};display:inline-block;"></span>\${esc(t.name)}</span>\`; });
    svg += '</div>';
  }
  return svg;
}

function escSvg(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════
// ── Node detail popup ──
// ═══════════════════════════════════════

function showNodeDetail(event, nodeId) {
  if (!currentRunData) return;
  const node = currentRunData.nodes.find(n => n.node_id === nodeId);
  if (!node) return;
  const inE = currentRunData.edges.filter(e => e.target_id === nodeId);
  const outE = currentRunData.edges.filter(e => e.source_id === nodeId);
  const team = currentRunData.teams.find(t => t.team_id === node.team_id);

  // Find agent output/error messages for this node (Gap 2/4)
  const nodeMessages = currentRunData.messages.filter(m => m.node_id === nodeId && (m.message_type === 'agent_output' || m.message_type === 'agent_error'));
  let agentHistoryHtml = '';
  if (nodeMessages.length > 0) {
    agentHistoryHtml = '<h4 style="color:#716c6b;font-size:11px;text-transform:uppercase;margin-top:10px;">Agent History</h4>';
    nodeMessages.forEach(function(m, i) {
      const isError = m.message_type === 'agent_error';
      const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
      const statusBadge = isError ? '<span class="badge failed">failed</span>' : '<span class="badge completed">completed</span>';
      agentHistoryHtml += '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid rgba(245,232,232,0.15);">'
        + '<div style="display:flex;align-items:center;gap:6px;">'
        + '<span style="color:#716c6b;">#' + (i+1) + '</span>'
        + '<span style="color:#b7b1b1;">' + esc(m.sender_id.slice(-8)) + '</span>'
        + statusBadge
        + '<span style="color:#645f5f;margin-left:auto;">' + time + '</span>'
        + '</div>'
        + '<div style="color:#716c6b;margin-top:2px;max-height:60px;overflow:hidden;text-overflow:ellipsis;">' + esc(m.content.slice(0, 200)) + '</div>'
        + '</div>';
    });
  }

  const popup = document.getElementById('nodeDetailPopup');
  const content = document.getElementById('nodeDetailContent');
  content.innerHTML = \`
    <h4 style="color:#f1ecec;font-size:14px;margin-bottom:8px;">\${esc(node.title || node.kind)}</h4>
    <div class="kv">
      <div class="k">Node ID</div><div class="v" style="font-size:10px;">\${node.node_id}</div>
      <div class="k">Kind</div><div class="v">\${esc(node.kind)}</div>
      <div class="k">Status</div><div class="v"><span class="badge \${node.status}">\${node.status}</span></div>
      <div class="k">Team</div><div class="v">\${esc(team ? team.name : node.team_id)}</div>
      <div class="k">Retries</div><div class="v">\${node.retry_count}</div>
    </div>
    \${inE.length ? '<div style="font-size:11px;color:#716c6b;margin-top:6px;">Depends on: ' + inE.map(e => '<span class="badge pending" style="margin-right:4px;">' + e.source_id.slice(-8) + '</span>').join('') + '</div>' : ''}
    \${outE.length ? '<div style="font-size:11px;color:#716c6b;margin-top:4px;">Blocks: ' + outE.map(e => '<span class="badge pending" style="margin-right:4px;">' + e.target_id.slice(-8) + '</span>').join('') + '</div>' : ''}
    \${agentHistoryHtml}
    \${selectedRun ? \`<div style="margin-top:10px;display:flex;gap:6px;">
      \${node.status === 'pending' ? '<button onclick="updateNode(\\'' + selectedRun + '\\',\\'' + nodeId + '\\',\\'active\\');closeNodeDetail()">Activate</button>' : ''}
      \${node.status === 'active' ? '<button onclick="updateNode(\\'' + selectedRun + '\\',\\'' + nodeId + '\\',\\'completed\\');closeNodeDetail()">Complete</button>' : ''}
    </div>\` : ''}
  \`;
  const x = Math.min(event.clientX + 10, window.innerWidth - 370);
  const y = Math.min(event.clientY - 20, window.innerHeight - 300);
  popup.style.left = x + 'px'; popup.style.top = y + 'px'; popup.style.display = 'block';
}

function closeNodeDetail() { document.getElementById('nodeDetailPopup').style.display = 'none'; }
document.addEventListener('click', (e) => {
  const popup = document.getElementById('nodeDetailPopup');
  if (popup.style.display === 'block' && !popup.contains(e.target) && !e.target.closest('.dag-node')) closeNodeDetail();
});

// ═══════════════════════════════════════
// ── Per-team message threads ──
// ═══════════════════════════════════════

function renderMessageThreads(messages, teams) {
  const visible = messages.filter(m => m.message_type !== 'node_metadata');
  if (!visible.length) return '<div class="empty">No messages</div>';
  const teamMap = {}; teams.forEach(t => { teamMap[t.team_id] = t; });
  const byTeam = {}; visible.forEach(m => { if (!byTeam[m.team_id]) byTeam[m.team_id] = []; byTeam[m.team_id].push(m); });

  // Render system thread first (planner_output, final_result)
  const teamOrder = Object.keys(byTeam);
  if (teamOrder.includes('system')) {
    teamOrder.splice(teamOrder.indexOf('system'), 1);
    teamOrder.unshift('system');
  }

  let html = '';
  for (const teamId of teamOrder) {
    const team = teamMap[teamId], teamName = team ? team.name : (teamId === 'system' ? 'System' : teamId), msgs = byTeam[teamId];
    html += '<div class="team-thread"><div class="team-thread-header"><span class="team-name"># ' + esc(teamName) + '</span><span class="badge ' + (team?.status||'active') + ' team-badge">' + msgs.length + ' messages</span></div><div class="msg-list">';
    msgs.forEach(m => {
      const ac = m.sender_id === 'orchestrator' ? 'orchestrator' : m.sender_id === 'user' ? 'user' : 'agent';
      const ini = m.sender_id.slice(0, 2);
      const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
      const tag = m.message_type !== 'chat' ? '<span class="msg-type-tag">' + esc(m.message_type) + '</span>' : '';

      if (m.message_type === 'planner_output') {
        // Render as structured tool call card (Gap 1)
        html += renderPlannerOutputCard(m);
      } else if (m.message_type === 'agent_output') {
        // Render using AgentOutputRenderer pattern (Gap 2)
        html += renderAgentOutputCard(m);
      } else if (m.message_type === 'agent_error') {
        // Render as error card (Gap 2)
        html += renderAgentErrorCard(m);
      } else if (m.message_type === 'final_result') {
        // Render as final result card (Gap 3)
        html += renderFinalResultCard(m);
      } else {
        html += '<div class="msg-bubble"><div class="msg-avatar ' + ac + '">' + esc(ini) + '</div><div class="msg-body"><div class="msg-sender">' + esc(m.sender_id) + tag + '<span class="msg-time">' + time + '</span></div><div class="msg-content">' + esc(m.content) + '</div></div></div>';
      }
    });
    html += '</div></div>';
  }
  return html;
}

function renderPlannerOutputCard(m) {
  let plan;
  try { plan = JSON.parse(m.content); } catch { return '<div class="msg-bubble"><div class="msg-content">' + esc(m.content) + '</div></div>'; }
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  let html = '<div class="msg-bubble"><div class="msg-avatar orchestrator" style="background:rgba(236,112,251,0.14);color:#dca2e0;">P</div><div class="msg-body">';
  html += '<div class="msg-sender">planner<span class="msg-type-tag">planner_output</span><span class="msg-time">' + time + '</span></div>';
  html += '<div class="ao-tool" style="margin-top:4px;">';
  html += '<div class="ao-tool-header" onclick="toggleToolBody(this)">';
  html += '<div class="ao-tool-icon other" style="background:rgba(236,112,251,0.14);color:#dca2e0;">P</div>';
  html += '<span class="ao-tool-name">Task Decomposition</span>';
  html += '<span class="ao-tool-file">' + (plan.tasks ? plan.tasks.length + ' tasks, ' + (plan.teams ? plan.teams.length : 0) + ' teams' : '') + '</span>';
  html += '<span class="ao-tool-status done">&#10003; done</span>';
  html += '</div>';
  html += '<div class="ao-tool-body">';
  if (plan.summary) html += '<div style="margin-bottom:8px;color:#716c6b;font-size:11px;">' + esc(plan.summary) + '</div>';
  if (plan.teams && plan.teams.length) {
    html += '<div style="margin-bottom:6px;font-size:11px;"><strong style="color:#f1ecec;">Teams:</strong> ' + plan.teams.map(function(t) { return '<span class="badge active" style="margin-right:4px;">' + esc(t.name || t.id) + '</span>'; }).join('') + '</div>';
  }
  if (plan.tasks && plan.tasks.length) {
    html += '<div style="font-size:11px;">';
    plan.tasks.forEach(function(task) {
      const depStr = task.depends_on && task.depends_on.length ? ' &larr; ' + task.depends_on.join(', ') : '';
      html += '<div class="ao-plan-item" style="padding:3px 0;">';
      html += '<div class="ao-plan-check pending"></div>';
      html += '<div><span style="color:#f1ecec;font-weight:600;">' + esc(task.title || task.id) + '</span>';
      html += ' <span style="color:#716c6b;">(' + esc(task.kind) + ')</span>';
      html += ' <span style="color:#89b5ff;font-size:10px;">[' + esc(task.team) + ']</span>';
      if (depStr) html += ' <span style="color:#fdd63c;font-size:10px;">' + depStr + '</span>';
      html += '</div></div>';
    });
    html += '</div>';
  }
  html += '</div></div></div></div>';
  return html;
}

function renderAgentOutputCard(m) {
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  const nodeTag = m.node_id ? '<span class="msg-type-tag">' + esc(m.node_id.slice(-8)) + '</span>' : '';
  let html = '<div class="msg-bubble"><div class="msg-avatar agent">AG</div><div class="msg-body">';
  html += '<div class="msg-sender">' + esc(m.sender_id) + '<span class="msg-type-tag">agent_output</span>' + nodeTag + '<span class="msg-time">' + time + '</span></div>';
  // Use a container div that will render via AgentOutputRenderer if needed
  const renderId = 'ao_' + (m.id || Date.now());
  html += '<div class="agent-output" id="' + renderId + '" style="max-height:400px;">';
  // Pre-render as text; the renderer will be initialized after mount
  html += '<div class="ao-block"><div class="ao-text">' + renderMarkdown(m.content.slice(0, 5000)) + '</div></div>';
  html += '</div></div></div>';
  return html;
}

function renderAgentErrorCard(m) {
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  const nodeTag = m.node_id ? '<span class="msg-type-tag">' + esc(m.node_id.slice(-8)) + '</span>' : '';
  let html = '<div class="msg-bubble"><div class="msg-avatar agent" style="background:rgba(251,34,0,0.18);color:#ff917b;">!</div><div class="msg-body">';
  html += '<div class="msg-sender">' + esc(m.sender_id) + '<span class="msg-type-tag" style="background:rgba(251,34,0,0.18);color:#ff917b;">agent_error</span>' + nodeTag + '<span class="msg-time">' + time + '</span></div>';
  html += '<div class="output-box" style="border-color:rgba(252,83,58,0.4);max-height:200px;">' + esc(m.content.slice(0, 3000)) + '</div>';
  html += '</div></div>';
  return html;
}

function renderFinalResultCard(m) {
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  let html = '<div class="msg-bubble"><div class="msg-avatar orchestrator" style="background:rgba(51,255,34,0.12);color:#37db2e;">&#10003;</div><div class="msg-body">';
  html += '<div class="msg-sender">orchestrator<span class="msg-type-tag" style="background:rgba(51,255,34,0.12);color:#37db2e;">final_result</span><span class="msg-time">' + time + '</span></div>';
  html += '<div class="agent-output" style="max-height:600px;">';
  html += '<div class="ao-block ao-result success"><span class="result-icon">&#9989;</span><span>Run Completed</span></div>';
  html += '<div class="ao-block"><div class="ao-text">' + renderMarkdown(m.content.slice(0, 10000)) + '</div></div>';
  html += '</div></div></div>';
  return html;
}

// ═══════════════════════════════════════
// ── Inline forms ──
// ═══════════════════════════════════════

function showAddTeam(runId) {
  document.getElementById('inlineForm').innerHTML = \`<div style="display:flex;gap:6px;align-items:center;margin-top:8px;"><input id="fTeamName" placeholder="Team name"><button class="primary" onclick="addTeam('\${runId}')">Create Team</button><button onclick="document.getElementById('inlineForm').innerHTML=''">Cancel</button></div>\`;
}
async function addTeam(runId) { const n = document.getElementById('fTeamName').value.trim(); if (!n) return; await api('/runs/'+runId+'/teams', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})}); await renderRunDetail(runId); }

function showAddNode(runId) {
  document.getElementById('inlineForm').innerHTML = \`<div style="display:flex;gap:6px;align-items:center;margin-top:8px;"><input id="fNodeTitle" placeholder="Title"><input id="fNodeKind" placeholder="Kind"><input id="fNodeTeam" placeholder="Team ID"><button class="primary" onclick="addNode('\${runId}')">Create Node</button><button onclick="document.getElementById('inlineForm').innerHTML=''">Cancel</button></div>\`;
}
async function addNode(runId) { const t = document.getElementById('fNodeTitle').value.trim(), k = document.getElementById('fNodeKind').value.trim(), tid = document.getElementById('fNodeTeam').value.trim(); if (!k||!tid) return; await api('/runs/'+runId+'/nodes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:k,team_id:tid,title:t})}); await renderRunDetail(runId); }

function showAddMessage(runId) {
  document.getElementById('inlineForm').innerHTML = \`<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;"><input id="fMsgTeam" placeholder="Team ID"><input id="fMsgSender" placeholder="Sender ID"><input id="fMsgType" placeholder="Type" value="chat"><input id="fMsgContent" placeholder="Content" style="flex:1;min-width:150px;"><button class="primary" onclick="addMessage('\${runId}')">Send</button><button onclick="document.getElementById('inlineForm').innerHTML=''">Cancel</button></div>\`;
}
async function addMessage(runId) { const tid=document.getElementById('fMsgTeam').value.trim(),sid=document.getElementById('fMsgSender').value.trim(),mt=document.getElementById('fMsgType').value.trim(),c=document.getElementById('fMsgContent').value.trim(); if(!tid||!sid||!c||!mt) return; await api('/runs/'+runId+'/messages', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({team_id:tid,sender_id:sid,content:c,message_type:mt})}); await renderRunDetail(runId); }

function showAddEdge(runId) {
  document.getElementById('inlineForm').innerHTML = \`<div style="display:flex;gap:6px;align-items:center;margin-top:8px;"><input id="fEdgeSrc" placeholder="Source node ID"><input id="fEdgeTgt" placeholder="Target node ID"><input id="fEdgeType" placeholder="Type" value="depends_on"><button class="primary" onclick="addEdge('\${runId}')">Add Edge</button><button onclick="document.getElementById('inlineForm').innerHTML=''">Cancel</button></div>\`;
}
async function addEdge(runId) { const s=document.getElementById('fEdgeSrc').value.trim(),t=document.getElementById('fEdgeTgt').value.trim(),tp=document.getElementById('fEdgeType').value.trim(); if(!s||!t||!tp) return; await api('/runs/'+runId+'/edges', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_id:s,target_id:t,type:tp})}); await renderRunDetail(runId); }

async function updateNode(runId, nodeId, status) { await api('/runs/'+runId+'/nodes/'+nodeId, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); await renderRunDetail(runId); }

// ═══════════════════════════════════════
// ── Agents — with Universal Renderer ──
// ═══════════════════════════════════════

async function loadAgents() {
  const agents = await api('/agent/list');
  const el = document.getElementById('agentsList');
  if (!agents.length) { el.innerHTML = '<div class="empty">No agents</div>'; return; }
  el.innerHTML = agents.map(a => \`
    <div class="item \${selectedAgent === a.id ? 'selected' : ''}" onclick="selectAgent('\${a.id}')">
      <div class="dot \${a.status}"></div>
      <div class="label">\${esc(a.prompt.slice(0, 60))}</div>
      <div class="meta">\${a.status}</div>
    </div>
  \`).join('');
}

async function selectAgent(agentId) {
  selectedAgent = agentId;
  selectedRun = null;
  await loadAgents();
  await loadRuns();
  await renderAgentDetail(agentId);
}

async function renderAgentDetail(agentId) {
  const info = await api('/agent/' + agentId + '/status');
  const panel = document.getElementById('mainPanel');
  panel.innerHTML = \`
    <div class="panel">
      <h2>Agent</h2>
      <div class="kv">
        <div class="k">ID</div><div class="v">\${info.id}</div>
        <div class="k">Status</div><div class="v"><span class="badge \${info.status}">\${info.status}</span></div>
        <div class="k">Exit Code</div><div class="v">\${info.exit_code ?? '-'}</div>
        <div class="k">Run ID</div><div class="v">\${info.run_id || '-'}</div>
        <div class="k">Node ID</div><div class="v">\${info.node_id || '-'}</div>
        <div class="k">Created</div><div class="v">\${info.created_at}</div>
        <div class="k">Finished</div><div class="v">\${info.finished_at || '-'}</div>
      </div>
      \${info.status === 'running' ? '<button class="danger" onclick="killAgent(\\'' + agentId + '\\')">Kill Agent</button>' : ''}
    </div>
    <div class="panel">
      <h2>Output</h2>
      <div class="agent-output" id="agentOutput"></div>
    </div>
  \`;

  connectAgentStream(agentId);
}

function connectAgentStream(agentId) {
  if (agentEventSources[agentId]) {
    agentEventSources[agentId].close();
  }

  const outputEl = document.getElementById('agentOutput');
  if (!outputEl) return;

  // Create a new renderer for this agent
  const renderer = new AgentOutputRenderer(outputEl);
  renderers[agentId] = renderer;

  const es = new EventSource(BASE + '/agent/' + agentId + '/stream');
  agentEventSources[agentId] = es;

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'output') {
        renderer.ingestChunk(data.text);
      } else if (data.type === 'done') {
        renderer.finish(data.status, data.exit_code);
        es.close();
        delete agentEventSources[agentId];
        loadAgents();
      }
    } catch(_) {}
  };

  es.onerror = () => {
    es.close();
    delete agentEventSources[agentId];
  };
}

async function killAgent(agentId) {
  await api('/agent/' + agentId + '/kill', { method: 'POST' });
  setTimeout(() => { loadAgents(); if (selectedAgent === agentId) renderAgentDetail(agentId); }, 500);
}

// ═══════════════════════════════════════
// ── Spawn Modal ──
// ═══════════════════════════════════════

function openSpawnModal() { document.getElementById('spawnModal').classList.add('open'); }
function closeSpawnModal() { document.getElementById('spawnModal').classList.remove('open'); }

async function spawnAgent() {
  const prompt = document.getElementById('spawnPrompt').value.trim();
  if (!prompt) return;
  const body = { prompt };
  const cwd = document.getElementById('spawnCwd').value.trim();
  const run_id = document.getElementById('spawnRunId').value.trim();
  const node_id = document.getElementById('spawnNodeId').value.trim();
  if (cwd) body.cwd = cwd;
  if (run_id) body.run_id = run_id;
  if (node_id) body.node_id = node_id;
  const result = await api('/agent/spawn', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  closeSpawnModal();
  document.getElementById('spawnPrompt').value = '';
  document.getElementById('spawnCwd').value = '';
  document.getElementById('spawnRunId').value = '';
  document.getElementById('spawnNodeId').value = '';
  await loadAgents();
  selectAgent(result.id);
}

// ═══════════════════════════════════════
// ── Utilities ──
// ═══════════════════════════════════════

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

async function refreshAll() {
  await Promise.all([loadRuns(), loadAgents()]);
  if (selectedRun) await renderRunDetail(selectedRun);
  if (selectedAgent) await renderAgentDetail(selectedAgent);
}

// ── Init ──
refreshAll();
setInterval(() => { loadRuns(); loadAgents(); }, 5000);
</script>
</body>
</html>`;
}
