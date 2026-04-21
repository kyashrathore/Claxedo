/**
 * Guest-side selector generator — bundled into the main-process output as a
 * **string asset**. When the user clicks an element via the CDP overlay, the
 * main process dispatches this IIFE into the guest page via `Runtime.evaluate`
 * and gets back a structured `SelectorGenerationResult` (JSON-serializable).
 *
 * Why a string asset rather than a real module:
 *
 *   - The main process has no DOM. `@medv/finder` needs `document`, `Node`,
 *     `HTMLElement`, `CSS.escape`, etc — all guest-side primitives.
 *   - `Runtime.evaluate` takes an `expression` string. The cleanest build
 *     contract is "we carry the exact source we'd inject" as a const.
 *   - Tests can `require()` the .ts file and `new Function()` the script
 *     inside a happy-dom context to verify generation against fixture DOMs.
 *
 * The script is idempotent and self-contained: running it twice on the same
 * guest is harmless. It evaluates to an object `{ ok, selector?, frameUrl,
 * boundingBox?, outerHTML?, error? }` wrapped in a top-level expression so
 * `Runtime.evaluate({ returnByValue: true })` picks it up by value.
 *
 * Bundled `@medv/finder` source (v4.0.2, MIT, Anton Medvedev) is inlined in
 * the IIFE so the script has no external dependencies inside the guest.
 *
 * Configuration choices (match plan's preference ladder):
 *
 *   - `attr` prefers `data-testid` / `data-test` / `data-cy` (score 0 penalty
 *     equivalent by returning true for them even if the default `wordLike`
 *     would reject them).
 *   - `idName` and `className` reject CSS-in-JS prefixes (`css-`, `sc-`,
 *     `jsx-`, `_module_`) and falls back to finder's default wordLike gate.
 *   - `seedMinLength` / `optimizedMinLength` nudged up so short selectors
 *     lose to richer, more stable ones when both are unique.
 *   - Open shadow roots emit a composite `{ host, shadow }` path; closed
 *     shadow roots emit `{ ok: false, error: "shadow-root-closed" }`.
 */

/**
 * Public type emitted by the guest script (returned to main via
 * `returnByValue`). Main-process code must stay in sync with this shape.
 */
export type GuestSelectorPath = {
  /** CSS selector rooted at the document this element belongs to. */
  selector: string
  /** If the element is inside an open shadow root, the composite path. */
  shadow?: { host: string; inner: string }
}

export type GuestSelectorOk = {
  ok: true
  frameUrl: string
  path: GuestSelectorPath
  boundingBox?: { x: number; y: number; width: number; height: number }
  outerHTML?: string
  tagName: string
}

export type GuestSelectorErr = {
  ok: false
  frameUrl: string
  error:
    | "element-not-found"
    | "shadow-root-closed"
    | "timeout"
    | "generic"
  message?: string
}

export type GuestSelectorResult = GuestSelectorOk | GuestSelectorErr

/**
 * Evaluate-compatible script body. When main dispatches this via CDP, it wraps
 * the body in `(() => { ... })()` and appends a call expression that returns
 * the result by value. A lookup function `__claxedoFindFocusedElement` is used
 * because the main process passes the element via `Runtime.callFunctionOn`'s
 * `objectId` channel when possible, and via a global storage key otherwise.
 *
 * Entry point: `__claxedoGenerateSelectorForElement(el: Element)`.
 */
export const GUEST_SELECTOR_SCRIPT = /* js */ `
(() => {
  if (typeof window === "undefined") return null;
  // Idempotent install: bail out if the guest already has a generator. This
  // matters both for perf (re-running the IIFE via Runtime.evaluate costs ~1ms
  // and allocates a fresh @medv/finder closure) and for tests that override
  // the installed generator after first mount.
  if (window.__claxedoGuestSelector && typeof window.__claxedoGuestSelector.generateResultForElement === "function") {
    return true;
  }

  // ── @medv/finder v4.0.2 (MIT, Anton Medvedev) ─────────────────────────
  // Inlined so the guest doesn't need a network fetch; rewritten to IIFE
  // so no module scope is required.

  const __finder = (() => {
    const acceptedAttrNames = new Set(['role', 'name', 'aria-label', 'rel', 'href']);
    function wordLike(name) {
      if (/^[a-z\\-]{3,}$/i.test(name)) {
        const words = name.split(/-|[A-Z]/);
        for (const word of words) {
          if (word.length <= 2) return false;
          if (/[^aeiou]{4,}/i.test(word)) return false;
        }
        return true;
      }
      return false;
    }
    function attr(name, value) {
      let nameIsOk = acceptedAttrNames.has(name);
      nameIsOk ||= name.startsWith('data-') && wordLike(name);
      let valueIsOk = wordLike(value) && value.length < 100;
      valueIsOk ||= value.startsWith('#') && wordLike(value.slice(1));
      return nameIsOk && valueIsOk;
    }
    function idName(name) { return wordLike(name); }
    function className(name) { return wordLike(name); }
    function tagName() { return true; }

    function* search(input, config, rootDocument) {
      const stack = [];
      let paths = [];
      let current = input;
      let i = 0;
      while (current && current !== rootDocument) {
        const level = tie(current, config);
        for (const node of level) node.level = i;
        stack.push(level);
        current = current.parentElement;
        i++;
        paths.push(...combinations(stack));
        if (i >= config.seedMinLength) {
          paths.sort(byPenalty);
          for (const candidate of paths) yield candidate;
          paths = [];
        }
      }
      paths.sort(byPenalty);
      for (const candidate of paths) yield candidate;
    }
    function tie(element, config) {
      const level = [];
      const elementId = element.getAttribute('id');
      if (elementId && config.idName(elementId)) {
        level.push({ name: '#' + CSS.escape(elementId), penalty: 0 });
      }
      for (let i = 0; i < element.classList.length; i++) {
        const name = element.classList[i];
        if (config.className(name)) {
          level.push({ name: '.' + CSS.escape(name), penalty: 1 });
        }
      }
      for (let i = 0; i < element.attributes.length; i++) {
        const a = element.attributes[i];
        if (config.attr(a.name, a.value)) {
          level.push({
            name: '[' + CSS.escape(a.name) + '="' + CSS.escape(a.value) + '"]',
            penalty: 2,
          });
        }
      }
      const tn = element.tagName.toLowerCase();
      if (config.tagName(tn)) {
        level.push({ name: tn, penalty: 5 });
        const index = indexOf(element, tn);
        if (index !== undefined) level.push({ name: nthOfType(tn, index), penalty: 10 });
      }
      const nth = indexOf(element);
      if (nth !== undefined) level.push({ name: nthChild(tn, nth), penalty: 50 });
      return level;
    }
    function selector(path) {
      let node = path[0];
      let query = node.name;
      for (let i = 1; i < path.length; i++) {
        const level = path[i].level || 0;
        if (node.level === level - 1) query = path[i].name + ' > ' + query;
        else query = path[i].name + ' ' + query;
        node = path[i];
      }
      return query;
    }
    function penalty(path) { return path.map(n => n.penalty).reduce((a, b) => a + b, 0); }
    function byPenalty(a, b) { return penalty(a) - penalty(b); }
    function indexOf(input, tn) {
      const parent = input.parentNode;
      if (!parent) return undefined;
      let child = parent.firstChild;
      if (!child) return undefined;
      let i = 0;
      while (child) {
        if (child.nodeType === Node.ELEMENT_NODE &&
            (tn === undefined || child.tagName.toLowerCase() === tn)) i++;
        if (child === input) break;
        child = child.nextSibling;
      }
      return i;
    }
    function nthChild(tn, index) {
      if (tn === 'html') return 'html';
      return tn + ':nth-child(' + index + ')';
    }
    function nthOfType(tn, index) {
      if (tn === 'html') return 'html';
      return tn + ':nth-of-type(' + index + ')';
    }
    function* combinations(stack, path = []) {
      if (stack.length > 0) {
        for (const node of stack[0]) {
          yield* combinations(stack.slice(1), path.concat(node));
        }
      } else {
        yield path;
      }
    }
    function fallback(input, rootDocument) {
      let i = 0;
      let current = input;
      const path = [];
      while (current && current !== rootDocument) {
        const tn = current.tagName.toLowerCase();
        const index = indexOf(current, tn);
        if (index === undefined) return;
        path.push({ name: nthOfType(tn, index), penalty: NaN, level: i });
        current = current.parentElement;
        i++;
      }
      if (unique(path, rootDocument)) return path;
    }
    function unique(path, rootDocument) {
      const css = selector(path);
      try {
        switch (rootDocument.querySelectorAll(css).length) {
          case 0: return false;
          case 1: return true;
          default: return false;
        }
      } catch (_) {
        return false;
      }
    }
    function* optimize(path, input, config, rootDocument, startTime) {
      if (path.length > 2 && path.length > config.optimizedMinLength) {
        for (let i = 1; i < path.length - 1; i++) {
          const elapsedTimeMs = Date.now() - startTime;
          if (elapsedTimeMs > config.timeoutMs) return;
          const newPath = [...path];
          newPath.splice(i, 1);
          if (unique(newPath, rootDocument) &&
              rootDocument.querySelector(selector(newPath)) === input) {
            yield newPath;
            yield* optimize(newPath, input, config, rootDocument, startTime);
          }
        }
      }
    }
    function findRootDocument(rootNode, defaults) {
      if (rootNode.nodeType === Node.DOCUMENT_NODE) return rootNode;
      if (rootNode === defaults.root) return rootNode.ownerDocument;
      return rootNode;
    }

    function finder(input, options) {
      if (input.nodeType !== Node.ELEMENT_NODE) {
        throw new Error("Can't generate CSS selector for non-element node type.");
      }
      if (input.tagName.toLowerCase() === 'html') return 'html';
      const defaults = {
        root: (input.ownerDocument && input.ownerDocument.body) || document.body,
        idName, className, tagName, attr,
        timeoutMs: 1000,
        seedMinLength: 3,
        optimizedMinLength: 2,
        maxNumberOfPathChecks: Infinity,
      };
      const startTime = Date.now();
      const config = { ...defaults, ...options };
      const rootDocument = findRootDocument(config.root, defaults);
      let foundPath;
      let count = 0;
      for (const candidate of search(input, config, rootDocument)) {
        const elapsedTimeMs = Date.now() - startTime;
        if (elapsedTimeMs > config.timeoutMs || count >= config.maxNumberOfPathChecks) {
          const fPath = fallback(input, rootDocument);
          if (!fPath) throw new Error('Timeout');
          return selector(fPath);
        }
        count++;
        if (unique(candidate, rootDocument)) { foundPath = candidate; break; }
      }
      if (!foundPath) {
        const fPath = fallback(input, rootDocument);
        if (!fPath) throw new Error('Selector was not found.');
        return selector(fPath);
      }
      const optimized = [...optimize(foundPath, input, config, rootDocument, startTime)];
      optimized.sort(byPenalty);
      if (optimized.length > 0) return selector(optimized[0]);
      return selector(foundPath);
    }
    return { finder };
  })();

  // ── claxedo-specific preference ladder ────────────────────────────────
  // Reject common CSS-in-JS prefixes so \`css-a1b2c3\` never wins.
  const REJECT_PREFIXES = ['css-', 'sc-', 'jsx-', '_module_'];
  function isStableClass(name) {
    const lower = name.toLowerCase();
    for (const p of REJECT_PREFIXES) if (lower.startsWith(p)) return false;
    return /^[a-z][a-z0-9\\-_]{2,}$/i.test(name);
  }
  function isStableId(name) {
    const lower = name.toLowerCase();
    for (const p of REJECT_PREFIXES) if (lower.startsWith(p)) return false;
    return /^[a-z][a-z0-9\\-_]{2,}$/i.test(name);
  }
  function isStableAttr(name, value) {
    if (name === 'data-testid' || name === 'data-test' || name === 'data-cy') {
      return typeof value === 'string' && value.length > 0 && value.length < 200;
    }
    if (name === 'role' || name === 'name' || name === 'aria-label' || name === 'rel' || name === 'href') {
      return typeof value === 'string' && value.length > 0 && value.length < 200;
    }
    if (name.startsWith('data-') && /^data-[a-z][a-z0-9\\-]{2,}$/i.test(name)) {
      return typeof value === 'string' && value.length > 0 && value.length < 200;
    }
    return false;
  }

  function findShadowHost(el) {
    let cursor = el;
    while (cursor) {
      const root = cursor.getRootNode && cursor.getRootNode();
      // ShadowRoot has a \`host\` property; Document does not.
      if (root && root !== document && root.host) return { shadowRoot: root, host: root.host };
      cursor = cursor.parentElement || (cursor.parentNode && cursor.parentNode.host) || null;
    }
    return null;
  }

  function generateSelectorForElement(el, opts) {
    opts = opts || {};
    if (!el || el.nodeType !== 1) {
      return { ok: false, error: 'element-not-found' };
    }

    // Determine the traversal root. Inside a shadow root, we scope to the
    // root's first child so :nth-of-type math and querySelectorAll uniqueness
    // checks stay inside the shadow tree.
    const traversalRoot = opts.traversalRoot || (el.ownerDocument && el.ownerDocument.body) || document.body;
    const uniquenessRoot = opts.uniquenessRoot || (el.ownerDocument || document);

    // Fast path: prefer a single \`data-testid\` / \`data-test\` / \`data-cy\`
    // attribute. Unique short selectors beat long class chains every time.
    const testAttr = ['data-testid', 'data-test', 'data-cy'];
    for (const a of testAttr) {
      const v = el.getAttribute(a);
      if (typeof v === 'string' && v.length > 0 && v.length < 200) {
        const css = '[' + a + '="' + CSS.escape(v) + '"]';
        try {
          if (uniquenessRoot.querySelectorAll(css).length === 1) {
            return { ok: true, css };
          }
        } catch (_) {}
      }
    }

    // Otherwise delegate to @medv/finder with our CSS-in-JS rejecter.
    const options = {
      root: traversalRoot,
      idName: isStableId,
      className: isStableClass,
      attr: isStableAttr,
      seedMinLength: 2,
      optimizedMinLength: 2,
      timeoutMs: 750,
    };
    try {
      const css = __finder.finder(el, options);
      return { ok: true, css };
    } catch (e) {
      // Fall through to manual :nth-of-type chain.
      const chain = [];
      let cur = el;
      const stopAt = opts.uniquenessRoot || el.ownerDocument || document;
      const ownerDoc = stopAt;
      while (cur && cur !== ownerDoc && cur.nodeType === 1) {
        const tn = cur.tagName.toLowerCase();
        let index = 0;
        let sib = cur.parentNode && cur.parentNode.firstChild;
        let found = false;
        while (sib) {
          if (sib.nodeType === 1 && sib.tagName && sib.tagName.toLowerCase() === tn) {
            index++;
            if (sib === cur) { found = true; break; }
          }
          sib = sib.nextSibling;
        }
        if (!found) break;
        chain.unshift(tn + ':nth-of-type(' + index + ')');
        cur = cur.parentElement;
      }
      const css = chain.length > 0 ? chain.join(' > ') : '*';
      try {
        if (ownerDoc.querySelectorAll(css).length === 1) return { ok: true, css };
      } catch (_) {}
      return { ok: false, error: 'generic', message: String((e && e.message) || e) };
    }
  }

  function generateResultForElement(el) {
    const frameUrl = (() => {
      try { return window.location && window.location.href ? String(window.location.href) : ''; }
      catch (_) { return ''; }
    })();

    if (!el || el.nodeType !== 1) {
      return { ok: false, frameUrl, error: 'element-not-found' };
    }

    // If the element lives in a shadow root, emit composite { host, inner }.
    const shadowInfo = findShadowHost(el);
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';

    let bbox;
    try {
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && r.width >= 0 && r.height >= 0) {
        bbox = { x: r.x || r.left || 0, y: r.y || r.top || 0, width: r.width, height: r.height };
      }
    } catch (_) {}

    let outerHTML;
    try {
      if (typeof el.outerHTML === 'string' && el.outerHTML.length < 2048) {
        outerHTML = el.outerHTML;
      } else if (typeof el.outerHTML === 'string') {
        outerHTML = el.outerHTML.slice(0, 2048) + '…';
      }
    } catch (_) {}

    if (shadowInfo) {
      // Composite selector.
      const hostResult = generateSelectorForElement(shadowInfo.host);
      // Inner traversal is scoped to the shadow root so :nth-of-type counts
      // among shadow siblings only and uniqueness checks run against the
      // shadow tree. The finder library expects an Element \`root\` — pick the
      // first element child of the shadow root (or the root itself if it
      // behaves like an element).
      let innerRoot = shadowInfo.shadowRoot.firstElementChild || shadowInfo.shadowRoot;
      const innerResult = generateSelectorForElement(el, {
        traversalRoot: innerRoot,
        uniquenessRoot: shadowInfo.shadowRoot,
      });
      if (!hostResult.ok) return { ok: false, frameUrl, error: hostResult.error || 'generic', message: hostResult.message };
      if (!innerResult.ok) return { ok: false, frameUrl, error: innerResult.error || 'generic', message: innerResult.message };
      return {
        ok: true,
        frameUrl,
        path: { selector: hostResult.css, shadow: { host: hostResult.css, inner: innerResult.css } },
        boundingBox: bbox,
        outerHTML,
        tagName,
      };
    }

    const r = generateSelectorForElement(el);
    if (!r.ok) return { ok: false, frameUrl, error: r.error || 'generic', message: r.message };
    return { ok: true, frameUrl, path: { selector: r.css }, boundingBox: bbox, outerHTML, tagName };
  }

  // Entry points the main-process wrapper calls. One writes the resolved
  // element to a global; \`runForStored\` reads it back so we can share the
  // IIFE between \`Runtime.callFunctionOn\` and object-id-less dispatches.
  const store = (window.__claxedoGuestSelector = window.__claxedoGuestSelector || {});
  store.generateResultForElement = generateResultForElement;
  store.runForStoredElement = function () {
    const el = store.__focused;
    store.__focused = null;
    return generateResultForElement(el);
  };
  store.setFocused = function (el) { store.__focused = el; };

  return true;
})()
`

/**
 * Small wrapper: given a `backendNodeId`, produce a self-contained CDP
 * `Runtime.evaluate` expression that:
 *
 *   1. Ensures the guest-side selector module has been installed.
 *   2. Resolves the node via `document.__claxedoFindByBackendNodeId` (which
 *      the main process populates by round-tripping the node through
 *      `DOM.resolveNode` + `Runtime.callFunctionOn`).
 *
 * The main-process wrapper typically prefers `Runtime.callFunctionOn` (takes
 * an objectId directly) — this is a fallback for tests / when callFunctionOn
 * isn't available.
 */
export function guestInstallExpression(): string {
  return GUEST_SELECTOR_SCRIPT
}
