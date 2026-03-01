import { d as defineSchema, c as createStateStore, f as flattenToPointers, S as SPEC_DATA_PART_TYPE, a as applySpecPatch, n as nestedToFlat, g as getByPath, r as resolveAction, e as executeAction, b as evaluateVisibility, h as resolveActionParam, i as resolveBindings, j as resolveElementProps, k as runValidation, l as createMixedStreamParser, s as setByPath, m as removeByPath } from "./index-DtFgOg9Q.js";
import { b as createSignal, a as createComponent, j as addEventListener, i as insert, e as createRenderEffect, k as setStyleProperty, m as memo, c as createMemo, d as Show, g as createEffect, h as onCleanup, l as useContext, n as createContext, t as template, E as ErrorBoundary, F as For, f as delegateEvents } from "./styles-BYu1h1zk.js";
var schema = defineSchema(
  (s) => ({
    // What the AI-generated SPEC looks like
    spec: s.object({
      /** Root element key */
      root: s.string(),
      /** Flat map of elements by key */
      elements: s.record(
        s.object({
          /** Component type from catalog */
          type: s.ref("catalog.components"),
          /** Component props */
          props: s.propsOf("catalog.components"),
          /** Child element keys (flat reference) */
          children: s.array(s.string()),
          /** Visibility condition */
          visible: s.any()
        })
      )
    }),
    // What the CATALOG must provide
    catalog: s.object({
      /** Component definitions */
      components: s.map({
        /** Zod schema for component props */
        props: s.zod(),
        /** Slots for this component. Use ['default'] for children, or named slots like ['header', 'footer'] */
        slots: s.array(s.string()),
        /** Description for AI generation hints */
        description: s.string(),
        /** Example prop values used in prompt examples (auto-generated from Zod schema if omitted) */
        example: s.any()
      }),
      /** Action definitions (optional) */
      actions: s.map({
        /** Zod schema for action params */
        params: s.zod(),
        /** Description for AI generation hints */
        description: s.string()
      })
    })
  }),
  {
    builtInActions: [
      {
        name: "setState",
        description: "Update a value in the state model at the given statePath. Params: { statePath: string, value: any }"
      },
      {
        name: "pushState",
        description: 'Append an item to an array in state. Params: { statePath: string, value: any, clearStatePath?: string }. Value can contain {"$state":"/path"} refs and "$id" for auto IDs.'
      },
      {
        name: "removeState",
        description: "Remove an item from an array in state by index. Params: { statePath: string, index: number }"
      },
      {
        name: "validateForm",
        description: "Validate all registered form fields and write the result to state. Params: { statePath?: string }. Defaults to /formValidation. Result: { valid: boolean, errors: Record<string, string[]> }."
      }
    ],
    defaultRules: [
      // Element integrity
      "CRITICAL INTEGRITY CHECK: Before outputting ANY element that references children, you MUST have already output (or will output) each child as its own element. If an element has children: ['a', 'b'], then elements 'a' and 'b' MUST exist. A missing child element causes that entire branch of the UI to be invisible.",
      "SELF-CHECK: After generating all elements, mentally walk the tree from root. Every key in every children array must resolve to a defined element. If you find a gap, output the missing element immediately.",
      // Field placement
      'CRITICAL: The "visible" field goes on the ELEMENT object, NOT inside "props". Correct: {"type":"<ComponentName>","props":{},"visible":{"$state":"/tab","eq":"home"},"children":[...]}.',
      'CRITICAL: The "on" field goes on the ELEMENT object, NOT inside "props". Use on.press, on.change, on.submit etc. NEVER put action/actionParams inside props.',
      // State and data
      "When the user asks for a UI that displays data (e.g. blog posts, products, users), ALWAYS include a state field with realistic sample data. The state field is a top-level field on the spec (sibling of root/elements).",
      'When building repeating content backed by a state array (e.g. posts, products, items), use the "repeat" field on a container element. Example: { "type": "<ContainerComponent>", "props": {}, "repeat": { "statePath": "/posts", "key": "id" }, "children": ["post-card"] }. Replace <ContainerComponent> with an appropriate component from the AVAILABLE COMPONENTS list. Inside repeated children, use { "$item": "field" } to read a field from the current item, and { "$index": true } for the current array index. For two-way binding to an item field use { "$bindItem": "completed" }. Do NOT hardcode individual elements for each array item.',
      // Design quality
      "Design with visual hierarchy: use container components to group content, heading components for section titles, proper spacing, and status indicators. ONLY use components from the AVAILABLE COMPONENTS list.",
      "For data-rich UIs, use multi-column layout components if available. For forms and single-column content, use vertical layout components. ONLY use components from the AVAILABLE COMPONENTS list.",
      "Always include realistic, professional-looking sample data. For blogs include 3-4 posts with varied titles, authors, dates, categories. For products include names, prices, images. Never leave data empty."
    ]
  }
);
var elementTreeSchema = schema;
var StateContext = createContext(null);
function computeInitialFlat(isControlled, initialState) {
  if (isControlled) return null;
  if (Object.keys(initialState).length === 0) return {};
  return flattenToPointers(initialState);
}
function StateProvider(props) {
  let internalStore;
  if (!props.store) {
    internalStore = createStateStore(props.initialState ?? {});
  }
  const store = () => props.store ?? internalStore;
  props.store ? "controlled" : "uncontrolled";
  let prevInitialState = props.initialState;
  let prevFlat = computeInitialFlat(!!props.store, props.initialState ?? {});
  createEffect(() => {
    if (props.store) return;
    const initialState = props.initialState ?? {};
    if (initialState === prevInitialState) return;
    prevInitialState = initialState;
    const nextFlat = initialState && Object.keys(initialState).length > 0 ? flattenToPointers(initialState) : {};
    const prevFlatObj = prevFlat ?? {};
    const allKeys = /* @__PURE__ */ new Set([...Object.keys(prevFlatObj), ...Object.keys(nextFlat)]);
    const updates = {};
    for (const key of allKeys) {
      if (prevFlatObj[key] !== nextFlat[key]) {
        updates[key] = key in nextFlat ? nextFlat[key] : void 0;
      }
    }
    prevFlat = nextFlat;
    if (Object.keys(updates).length > 0) {
      store().update(updates);
    }
  });
  const [state, setState] = createSignal(store().getSnapshot(), {
    equals: false
  });
  const changeListeners = /* @__PURE__ */ new Set();
  const subscribeChanges = (listener) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };
  const notifyChanges = (changes) => {
    for (const listener of changeListeners) {
      listener(changes);
    }
  };
  createEffect(() => {
    const s = store();
    setState(s.getSnapshot());
    const unsubscribe = s.subscribe(() => {
      setState(s.getSnapshot());
    });
    onCleanup(unsubscribe);
  });
  const set = (path, value) => {
    const s = store();
    const prev = s.getSnapshot();
    const prevValue = getByPath(prev, path);
    s.set(path, value);
    if (prevValue !== value) {
      const changes = [{
        path,
        value
      }];
      notifyChanges(changes);
      if (!props.store && s.getSnapshot() !== prev) {
        props.onStateChange?.(changes);
      }
    }
  };
  const update = (updates) => {
    const s = store();
    const prev = s.getSnapshot();
    s.update(updates);
    const changes = [];
    for (const [path, value] of Object.entries(updates)) {
      if (getByPath(prev, path) !== value) {
        changes.push({
          path,
          value
        });
      }
    }
    if (changes.length > 0) {
      notifyChanges(changes);
      if (!props.store && s.getSnapshot() !== prev) {
        props.onStateChange?.(changes);
      }
    }
  };
  const get = (path) => store().get(path);
  const getSnapshot = () => store().getSnapshot();
  const ctx = {
    get state() {
      return state();
    },
    get,
    set,
    update,
    getSnapshot,
    subscribeChanges
  };
  return createComponent(StateContext.Provider, {
    value: ctx,
    get children() {
      return props.children;
    }
  });
}
function useStateStore() {
  const ctx = useContext(StateContext);
  if (!ctx) {
    throw new Error("useStateStore must be used within a StateProvider");
  }
  return ctx;
}
function useStateValue(path) {
  const store = useStateStore();
  return createMemo(() => getByPath(store.state, path));
}
function useStateBinding(path) {
  const store = useStateStore();
  const value = createMemo(() => getByPath(store.state, path));
  const setValue = (newValue) => store.set(path, newValue);
  return [value, setValue];
}
var VisibilityContext = createContext(null);
function VisibilityProvider(props) {
  const stateStore = useStateStore();
  const visibilityCtx = {
    get stateModel() {
      return stateStore.state;
    }
  };
  const value = {
    isVisible: (condition) => evaluateVisibility(condition, visibilityCtx),
    ctx: visibilityCtx
  };
  return createComponent(VisibilityContext.Provider, {
    value,
    get children() {
      return props.children;
    }
  });
}
function useVisibility() {
  const ctx = useContext(VisibilityContext);
  if (!ctx) {
    throw new Error("useVisibility must be used within a VisibilityProvider");
  }
  return ctx;
}
function useIsVisible(condition) {
  const {
    isVisible
  } = useVisibility();
  return isVisible(condition);
}
var ValidationContext = createContext(null);
function dynamicArgsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const va = a[key];
    const vb = b[key];
    if (va === vb) continue;
    if (typeof va === "object" && va !== null && typeof vb === "object" && vb !== null) {
      const sa = va.$state;
      const sb = vb.$state;
      if (typeof sa === "string" && sa === sb) continue;
    }
    return false;
  }
  return true;
}
function validationConfigEqual(a, b) {
  if (a === b) return true;
  if (a.validateOn !== b.validateOn) return false;
  const ac = a.checks ?? [];
  const bc = b.checks ?? [];
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    const ca = ac[i];
    const cb = bc[i];
    if (ca.type !== cb.type) return false;
    if (ca.message !== cb.message) return false;
    if (!dynamicArgsEqual(ca.args, cb.args)) return false;
  }
  return true;
}
function ValidationProvider(props) {
  const {
    getSnapshot
  } = useStateStore();
  const customFunctions = () => props.customFunctions ?? {};
  const [fieldStates, setFieldStates] = createSignal({});
  let fieldStatesRef = {};
  const [fieldConfigs, setFieldConfigs] = createSignal({});
  const registerField = (path, config) => {
    setFieldConfigs((prev) => {
      const existing = prev[path];
      if (existing && validationConfigEqual(existing, config)) {
        return prev;
      }
      return {
        ...prev,
        [path]: config
      };
    });
  };
  const validate = (path, config) => {
    const currentState = getSnapshot();
    const segments = path.split("/").filter(Boolean);
    let value2 = currentState;
    for (const seg of segments) {
      if (value2 != null && typeof value2 === "object") {
        value2 = value2[seg];
      } else {
        value2 = void 0;
        break;
      }
    }
    const result = runValidation(config, {
      value: value2,
      stateModel: currentState,
      customFunctions: customFunctions()
    });
    const newFieldState = {
      touched: fieldStatesRef[path]?.touched ?? true,
      validated: true,
      result
    };
    fieldStatesRef = {
      ...fieldStatesRef,
      [path]: newFieldState
    };
    setFieldStates(fieldStatesRef);
    return result;
  };
  const touch = (path) => {
    fieldStatesRef = {
      ...fieldStatesRef,
      [path]: {
        ...fieldStatesRef[path],
        touched: true,
        validated: fieldStatesRef[path]?.validated ?? false,
        result: fieldStatesRef[path]?.result ?? null
      }
    };
    setFieldStates(fieldStatesRef);
  };
  const clear = (path) => {
    const {
      [path]: _,
      ...rest
    } = fieldStatesRef;
    fieldStatesRef = rest;
    setFieldStates(rest);
  };
  const validateAll = () => {
    let allValid = true;
    for (const [path, config] of Object.entries(fieldConfigs())) {
      const result = validate(path, config);
      if (!result.valid) {
        allValid = false;
      }
    }
    return allValid;
  };
  const value = {
    get customFunctions() {
      return customFunctions();
    },
    get fieldStates() {
      fieldStates();
      return fieldStatesRef;
    },
    validate,
    touch,
    clear,
    validateAll,
    registerField
  };
  return createComponent(ValidationContext.Provider, {
    value,
    get children() {
      return props.children;
    }
  });
}
function useValidation() {
  const ctx = useContext(ValidationContext);
  if (!ctx) {
    throw new Error("useValidation must be used within a ValidationProvider");
  }
  return ctx;
}
function useOptionalValidation() {
  return useContext(ValidationContext);
}
function useFieldValidation(path, config) {
  const validation = useValidation();
  createEffect(() => {
    if (path && config) {
      validation.registerField(path, config);
    }
  });
  const state = createMemo(() => {
    const current = validation.fieldStates[path];
    return current ?? {
      touched: false,
      validated: false,
      result: null
    };
  });
  const validate = () => validation.validate(path, config ?? {
    checks: []
  });
  const touch = () => validation.touch(path);
  const clear = () => validation.clear(path);
  const errors = createMemo(() => state().result?.errors ?? []);
  const isValid = createMemo(() => state().result?.valid ?? true);
  return {
    state,
    validate,
    touch,
    clear,
    errors,
    isValid
  };
}
var _tmpl$ = /* @__PURE__ */ template(`<div style="position:fixed;inset:0;background-color:rgba(0, 0, 0, 0.5);display:flex;align-items:center;justify-content:center;z-index:50"><div style="background-color:white;border-radius:8px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 25px -5px rgba(0, 0, 0, 0.1)"><h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600"></h3><p style="margin:0 0 24px 0;color:#6b7280"></p><div style=display:flex;gap:12px;justify-content:flex-end><button style="padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background-color:white;cursor:pointer"></button><button style="padding:8px 16px;border-radius:6px;border:none;color:white;cursor:pointer">`);
var idCounter = 0;
function generateUniqueId() {
  idCounter += 1;
  return `${Date.now()}-${idCounter}`;
}
function deepResolveValue(value, get) {
  if (value === null || value === void 0) return value;
  if (value === "$id") {
    return generateUniqueId();
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj.$state === "string") {
      return get(obj.$state);
    }
    if (keys.length === 1 && "$id" in obj) {
      return generateUniqueId();
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepResolveValue(item, get));
  }
  if (typeof value === "object") {
    const resolved = {};
    for (const [key, val] of Object.entries(value)) {
      resolved[key] = deepResolveValue(val, get);
    }
    return resolved;
  }
  return value;
}
var ActionContext = createContext(null);
function ActionProvider(props) {
  const {
    get,
    set,
    getSnapshot
  } = useStateStore();
  const validation = useOptionalValidation();
  const [handlers, setHandlers] = createSignal(props.handlers ?? {});
  const [loadingActions, setLoadingActions] = createSignal(/* @__PURE__ */ new Set());
  const [pendingConfirmation, setPendingConfirmation] = createSignal(null);
  const registerHandler = (name, handler) => {
    setHandlers((prev) => ({
      ...prev,
      [name]: handler
    }));
  };
  const execute = async (binding) => {
    const resolved = resolveAction(binding, getSnapshot());
    if (resolved.action === "setState" && resolved.params) {
      const statePath = resolved.params.statePath;
      const value = resolved.params.value;
      if (statePath) {
        set(statePath, value);
      }
      return;
    }
    if (resolved.action === "pushState" && resolved.params) {
      const statePath = resolved.params.statePath;
      const rawValue = resolved.params.value;
      if (statePath) {
        const resolvedValue = deepResolveValue(rawValue, get);
        const arr = get(statePath) ?? [];
        set(statePath, [...arr, resolvedValue]);
        const clearStatePath = resolved.params.clearStatePath;
        if (clearStatePath) {
          set(clearStatePath, "");
        }
      }
      return;
    }
    if (resolved.action === "removeState" && resolved.params) {
      const statePath = resolved.params.statePath;
      const index = resolved.params.index;
      if (statePath !== void 0 && index !== void 0) {
        const arr = get(statePath) ?? [];
        set(statePath, arr.filter((_, i) => i !== index));
      }
      return;
    }
    if (resolved.action === "push" && resolved.params) {
      const screen = resolved.params.screen;
      if (screen) {
        const currentScreen = get("/currentScreen");
        const navStack = get("/navStack") ?? [];
        if (currentScreen) {
          set("/navStack", [...navStack, currentScreen]);
        } else {
          set("/navStack", [...navStack, ""]);
        }
        set("/currentScreen", screen);
      }
      return;
    }
    if (resolved.action === "pop") {
      const navStack = get("/navStack") ?? [];
      if (navStack.length > 0) {
        const previousScreen = navStack[navStack.length - 1];
        set("/navStack", navStack.slice(0, -1));
        if (previousScreen) {
          set("/currentScreen", previousScreen);
        } else {
          set("/currentScreen", void 0);
        }
      }
      return;
    }
    if (resolved.action === "validateForm") {
      const validateAll = validation?.validateAll;
      if (!validateAll) {
        console.warn("validateForm action was dispatched but no ValidationProvider is connected. Ensure ValidationProvider is rendered inside the provider tree.");
        return;
      }
      const valid = validateAll();
      const errors = {};
      for (const [path, fs] of Object.entries(validation.fieldStates)) {
        if (fs.result && !fs.result.valid) {
          errors[path] = fs.result.errors;
        }
      }
      const statePath = resolved.params?.statePath || "/formValidation";
      set(statePath, {
        valid,
        errors
      });
      return;
    }
    const handler = handlers()[resolved.action];
    if (!handler) {
      console.warn(`No handler registered for action: ${resolved.action}`);
      return;
    }
    if (resolved.confirm) {
      return new Promise((resolve, reject) => {
        setPendingConfirmation({
          action: resolved,
          handler,
          resolve: () => {
            setPendingConfirmation(null);
            resolve();
          },
          reject: () => {
            setPendingConfirmation(null);
            reject(new Error("Action cancelled"));
          }
        });
      }).then(async () => {
        setLoadingActions((prev) => new Set(prev).add(resolved.action));
        try {
          await executeAction({
            action: resolved,
            handler,
            setState: set,
            navigate: props.navigate,
            executeAction: async (name) => {
              const subBinding = {
                action: name
              };
              await execute(subBinding);
            }
          });
        } finally {
          setLoadingActions((prev) => {
            const next = new Set(prev);
            next.delete(resolved.action);
            return next;
          });
        }
      });
    }
    setLoadingActions((prev) => new Set(prev).add(resolved.action));
    try {
      await executeAction({
        action: resolved,
        handler,
        setState: set,
        navigate: props.navigate,
        executeAction: async (name) => {
          const subBinding = {
            action: name
          };
          await execute(subBinding);
        }
      });
    } finally {
      setLoadingActions((prev) => {
        const next = new Set(prev);
        next.delete(resolved.action);
        return next;
      });
    }
  };
  const confirm = () => {
    pendingConfirmation()?.resolve();
  };
  const cancel = () => {
    pendingConfirmation()?.reject();
  };
  const ctx = {
    get handlers() {
      return handlers();
    },
    get loadingActions() {
      return loadingActions();
    },
    get pendingConfirmation() {
      return pendingConfirmation();
    },
    execute,
    confirm,
    cancel,
    registerHandler
  };
  return createComponent(ActionContext.Provider, {
    value: ctx,
    get children() {
      return props.children;
    }
  });
}
function useActions() {
  const ctx = useContext(ActionContext);
  if (!ctx) {
    throw new Error("useActions must be used within an ActionProvider");
  }
  return ctx;
}
function useAction(binding) {
  const actions = useActions();
  return {
    execute: () => actions.execute(binding),
    get isLoading() {
      return actions.loadingActions.has(binding.action);
    }
  };
}
function ConfirmDialog(props) {
  const isDanger = () => props.confirm.variant === "danger";
  return (() => {
    var _el$ = _tmpl$(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild, _el$4 = _el$3.nextSibling, _el$5 = _el$4.nextSibling, _el$6 = _el$5.firstChild, _el$7 = _el$6.nextSibling;
    addEventListener(_el$, "click", props.onCancel, true);
    _el$2.$$click = (e) => e.stopPropagation();
    insert(_el$3, () => props.confirm.title);
    insert(_el$4, () => props.confirm.message);
    addEventListener(_el$6, "click", props.onCancel, true);
    insert(_el$6, () => props.confirm.cancelLabel ?? "Cancel");
    addEventListener(_el$7, "click", props.onConfirm, true);
    insert(_el$7, () => props.confirm.confirmLabel ?? "Confirm");
    createRenderEffect((_$p) => setStyleProperty(_el$7, "background-color", isDanger() ? "#dc2626" : "#3b82f6"));
    return _el$;
  })();
}
delegateEvents(["click"]);
var RepeatScopeContext = createContext(null);
function RepeatScopeProvider(props) {
  return createComponent(RepeatScopeContext.Provider, {
    get value() {
      return {
        item: props.item,
        index: props.index,
        basePath: props.basePath
      };
    },
    get children() {
      return props.children;
    }
  });
}
function useRepeatScope() {
  return useContext(RepeatScopeContext);
}
var EMPTY_FUNCTIONS = {};
var FunctionsContext = createContext(EMPTY_FUNCTIONS);
function useFunctions() {
  return useContext(FunctionsContext) ?? EMPTY_FUNCTIONS;
}
function ElementRenderer(props) {
  const repeatScope = useRepeatScope();
  const {
    ctx
  } = useVisibility();
  const {
    execute
  } = useActions();
  const stateStore = useStateStore();
  const getSnapshot = () => stateStore.getSnapshot();
  const functions = useFunctions();
  const fullCtx = createMemo(() => {
    const repeatItem = repeatScope?.item;
    const repeatIndex = repeatScope?.index;
    const repeatBasePath = repeatScope?.basePath;
    return {
      get stateModel() {
        return ctx.stateModel;
      },
      ...repeatItem !== void 0 ? {
        repeatItem
      } : {},
      ...repeatIndex !== void 0 ? {
        repeatIndex
      } : {},
      ...repeatBasePath !== void 0 ? {
        repeatBasePath
      } : {},
      functions
    };
  });
  const isVisible = createMemo(() => props.element.visible === void 0 ? true : evaluateVisibility(props.element.visible, fullCtx()));
  const emit = async (eventName) => {
    const onBindings = props.element.on;
    const binding = onBindings?.[eventName];
    if (!binding) return;
    const actionBindings = Array.isArray(binding) ? binding : [binding];
    for (const b of actionBindings) {
      if (!b.params) {
        await execute(b);
        continue;
      }
      const liveCtx = {
        ...fullCtx(),
        stateModel: getSnapshot()
      };
      const resolved = {};
      for (const [key, val] of Object.entries(b.params)) {
        resolved[key] = resolveActionParam(val, liveCtx);
      }
      await execute({
        ...b,
        params: resolved
      });
    }
  };
  const on = (eventName) => {
    const onBindings = props.element.on;
    const binding = onBindings?.[eventName];
    if (!binding) {
      return {
        emit: () => {
        },
        shouldPreventDefault: false,
        bound: false
      };
    }
    const actionBindings = Array.isArray(binding) ? binding : [binding];
    const shouldPreventDefault = actionBindings.some((b) => b.preventDefault);
    return {
      emit: () => emit(eventName),
      shouldPreventDefault,
      bound: true
    };
  };
  createEffect(() => {
    const watchConfig = props.element.watch;
    if (!watchConfig) return;
    const paths = Object.keys(watchConfig);
    if (paths.length === 0) return;
    const unsubscribe = stateStore.subscribeChanges((changes) => {
      const changedPaths = new Set(changes.map((change) => change.path));
      void (async () => {
        for (const path of paths) {
          if (!changedPaths.has(path)) continue;
          const binding = watchConfig[path];
          if (!binding) continue;
          const bindings = Array.isArray(binding) ? binding : [binding];
          for (const b of bindings) {
            if (!b.params) {
              await execute(b);
              continue;
            }
            const liveCtx = {
              ...fullCtx(),
              stateModel: getSnapshot()
            };
            const resolved = {};
            for (const [key, val] of Object.entries(b.params)) {
              resolved[key] = resolveActionParam(val, liveCtx);
            }
            await execute({
              ...b,
              params: resolved
            });
          }
        }
      })().catch(console.error);
    });
    onCleanup(() => {
      unsubscribe();
    });
  });
  const elementBindings = createMemo(() => {
    const rawProps = props.element.props;
    return resolveBindings(rawProps, fullCtx());
  });
  const resolvedElement = createMemo(() => {
    const rawProps = props.element.props;
    const resolvedProps = resolveElementProps(rawProps, fullCtx());
    return resolvedProps !== props.element.props ? {
      ...props.element,
      props: resolvedProps
    } : props.element;
  });
  return createComponent(Show, {
    get when() {
      return isVisible();
    },
    get children() {
      return createComponent(ErrorBoundary, {
        fallback: (err) => {
          console.error(`[json-render] Rendering error in <${props.element.type}>:`, err);
          return null;
        },
        get children() {
          return createComponent(ElementRendererContent, {
            get resolvedElement() {
              return resolvedElement();
            },
            get spec() {
              return props.spec;
            },
            get registry() {
              return props.registry;
            },
            get loading() {
              return props.loading;
            },
            get fallback() {
              return props.fallback;
            },
            emit,
            on,
            get bindings() {
              return elementBindings();
            }
          });
        }
      });
    }
  });
}
function ElementRendererContent(props) {
  const Comp = () => props.registry[props.resolvedElement.type] ?? props.fallback;
  return createComponent(Show, {
    get when() {
      return Comp();
    },
    get fallback() {
      console.warn(`No renderer for component type: ${props.resolvedElement.type}`);
      return null;
    },
    children: (ComponentFn) => {
      const Component = ComponentFn();
      const children = () => props.resolvedElement.repeat ? createComponent(RepeatChildren, {
        get element() {
          return props.resolvedElement;
        },
        get spec() {
          return props.spec;
        },
        get registry() {
          return props.registry;
        },
        get loading() {
          return props.loading;
        },
        get fallback() {
          return props.fallback;
        }
      }) : createComponent(For, {
        get each() {
          return props.resolvedElement.children ?? [];
        },
        children: (childKey) => {
          const childElement = () => props.spec.elements[childKey];
          return createComponent(Show, {
            get when() {
              return childElement();
            },
            get fallback() {
              if (!props.loading) {
                console.warn(`[json-render] Missing element "${childKey}" referenced as child of "${props.resolvedElement.type}". This element will not render.`);
              }
              return null;
            },
            children: (el) => createComponent(ElementRenderer, {
              get element() {
                return el();
              },
              get spec() {
                return props.spec;
              },
              get registry() {
                return props.registry;
              },
              get loading() {
                return props.loading;
              },
              get fallback() {
                return props.fallback;
              }
            })
          });
        }
      });
      return createComponent(Component, {
        get element() {
          return props.resolvedElement;
        },
        get emit() {
          return props.emit;
        },
        get on() {
          return props.on;
        },
        get bindings() {
          return props.bindings;
        },
        get loading() {
          return props.loading;
        },
        get children() {
          return children();
        }
      });
    }
  });
}
function RepeatChildren(props) {
  const stateStore = useStateStore();
  const repeat = () => props.element.repeat;
  const statePath = () => repeat().statePath;
  const items = () => getByPath(stateStore.state, statePath()) ?? [];
  return createComponent(For, {
    get each() {
      return items();
    },
    children: (itemValue, index) => {
      return createComponent(RepeatScopeProvider, {
        item: itemValue,
        get index() {
          return index();
        },
        get basePath() {
          return `${statePath()}/${index()}`;
        },
        get children() {
          return createComponent(For, {
            get each() {
              return props.element.children ?? [];
            },
            children: (childKey) => {
              const childElement = () => props.spec.elements[childKey];
              return createComponent(Show, {
                get when() {
                  return childElement();
                },
                get fallback() {
                  if (!props.loading) {
                    console.warn(`[json-render] Missing element "${childKey}" referenced as child of "${props.element.type}" (repeat). This element will not render.`);
                  }
                  return null;
                },
                children: (el) => createComponent(ElementRenderer, {
                  get element() {
                    return el();
                  },
                  get spec() {
                    return props.spec;
                  },
                  get registry() {
                    return props.registry;
                  },
                  get loading() {
                    return props.loading;
                  },
                  get fallback() {
                    return props.fallback;
                  }
                })
              });
            }
          });
        }
      });
    }
  });
}
function Renderer(props) {
  const rootElement = createMemo(() => {
    const spec = props.spec;
    if (!spec || !spec.root) return void 0;
    return spec.elements[spec.root];
  });
  return createComponent(Show, {
    get when() {
      return rootElement();
    },
    children: (el) => createComponent(ElementRenderer, {
      get element() {
        return el();
      },
      get spec() {
        return props.spec;
      },
      get registry() {
        return props.registry;
      },
      get loading() {
        return props.loading;
      },
      get fallback() {
        return props.fallback;
      }
    })
  });
}
function JSONUIProvider(props) {
  return createComponent(StateProvider, {
    get store() {
      return props.store;
    },
    get initialState() {
      return props.initialState;
    },
    get onStateChange() {
      return props.onStateChange;
    },
    get children() {
      return createComponent(VisibilityProvider, {
        get children() {
          return createComponent(ValidationProvider, {
            get customFunctions() {
              return props.validationFunctions;
            },
            get children() {
              return createComponent(ActionProvider, {
                get handlers() {
                  return props.handlers;
                },
                get navigate() {
                  return props.navigate;
                },
                get children() {
                  return createComponent(FunctionsContext.Provider, {
                    get value() {
                      return props.functions ?? EMPTY_FUNCTIONS;
                    },
                    get children() {
                      return [memo(() => props.children), createComponent(ConfirmationDialogManager, {})];
                    }
                  });
                }
              });
            }
          });
        }
      });
    }
  });
}
function ConfirmationDialogManager() {
  const {
    pendingConfirmation,
    confirm,
    cancel
  } = useActions();
  return createComponent(Show, {
    get when() {
      return pendingConfirmation?.action.confirm;
    },
    children: (confirmConfig) => createComponent(ConfirmDialog, {
      get confirm() {
        return confirmConfig();
      },
      onConfirm: confirm,
      onCancel: cancel
    })
  });
}
function defineRegistry(_catalog, options) {
  const registry = {};
  if (options.components) {
    for (const [name, componentFn] of Object.entries(options.components)) {
      registry[name] = (renderProps) => {
        return componentFn({
          get props() {
            return renderProps.element.props;
          },
          get children() {
            return renderProps.children;
          },
          emit: renderProps.emit,
          on: renderProps.on,
          get bindings() {
            return renderProps.bindings;
          },
          get loading() {
            return renderProps.loading;
          }
        });
      };
    }
  }
  const actionMap = options.actions ? Object.entries(options.actions) : [];
  const handlers = (getSetState, getState) => {
    const result = {};
    for (const [name, actionFn] of actionMap) {
      result[name] = async (params) => {
        const setState = getSetState();
        const state = getState();
        if (setState) {
          await actionFn(params, setState, state);
        }
      };
    }
    return result;
  };
  const executeAction2 = async (actionName, params, setState, state = {}) => {
    const entry = actionMap.find(([name]) => name === actionName);
    if (entry) {
      await entry[1](params, setState, state);
    } else {
      console.warn(`Unknown action: ${actionName}`);
    }
  };
  return {
    registry,
    handlers,
    executeAction: executeAction2
  };
}
function createRenderer(catalog, components) {
  const registry = components;
  return function CatalogRenderer(props) {
    const actionHandlers = () => props.onAction ? new Proxy({}, {
      get: (_target, prop) => {
        return (params) => props.onAction(prop, params);
      },
      has: () => true
    }) : void 0;
    return createComponent(StateProvider, {
      get store() {
        return props.store;
      },
      get initialState() {
        return props.state;
      },
      get onStateChange() {
        return props.onStateChange;
      },
      get children() {
        return createComponent(VisibilityProvider, {
          get children() {
            return createComponent(ValidationProvider, {
              get children() {
                return createComponent(ActionProvider, {
                  get handlers() {
                    return actionHandlers();
                  },
                  get children() {
                    return createComponent(FunctionsContext.Provider, {
                      get value() {
                        return props.functions ?? EMPTY_FUNCTIONS;
                      },
                      get children() {
                        return [createComponent(Renderer, {
                          get spec() {
                            return props.spec;
                          },
                          registry,
                          get loading() {
                            return props.loading;
                          },
                          get fallback() {
                            return props.fallback;
                          }
                        }), createComponent(ConfirmationDialogManager, {})];
                      }
                    });
                  }
                });
              }
            });
          }
        });
      }
    });
  };
}
function parseLine(line) {
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (parsed.__meta === "usage") {
      return {
        type: "usage",
        usage: {
          promptTokens: parsed.promptTokens ?? 0,
          completionTokens: parsed.completionTokens ?? 0,
          totalTokens: parsed.totalTokens ?? 0
        }
      };
    }
    return { type: "patch", patch: parsed };
  } catch {
    return null;
  }
}
function setSpecValue(newSpec, path, value) {
  if (path === "/root") {
    newSpec.root = value;
    return;
  }
  if (path === "/state") {
    newSpec.state = value;
    return;
  }
  if (path.startsWith("/state/")) {
    if (!newSpec.state) newSpec.state = {};
    const statePath = path.slice("/state".length);
    setByPath(newSpec.state, statePath, value);
    return;
  }
  if (path.startsWith("/elements/")) {
    const pathParts = path.slice("/elements/".length).split("/");
    const elementKey = pathParts[0];
    if (!elementKey) return;
    if (pathParts.length === 1) {
      newSpec.elements[elementKey] = value;
    } else {
      const element = newSpec.elements[elementKey];
      if (element) {
        const propPath = "/" + pathParts.slice(1).join("/");
        const newElement = { ...element };
        setByPath(
          newElement,
          propPath,
          value
        );
        newSpec.elements[elementKey] = newElement;
      }
    }
  }
}
function removeSpecValue(newSpec, path) {
  if (path === "/state") {
    delete newSpec.state;
    return;
  }
  if (path.startsWith("/state/") && newSpec.state) {
    const statePath = path.slice("/state".length);
    removeByPath(newSpec.state, statePath);
    return;
  }
  if (path.startsWith("/elements/")) {
    const pathParts = path.slice("/elements/".length).split("/");
    const elementKey = pathParts[0];
    if (!elementKey) return;
    if (pathParts.length === 1) {
      const { [elementKey]: _, ...rest } = newSpec.elements;
      newSpec.elements = rest;
    } else {
      const element = newSpec.elements[elementKey];
      if (element) {
        const propPath = "/" + pathParts.slice(1).join("/");
        const newElement = { ...element };
        removeByPath(
          newElement,
          propPath
        );
        newSpec.elements[elementKey] = newElement;
      }
    }
  }
}
function getSpecValue(spec, path) {
  if (path === "/root") return spec.root;
  if (path === "/state") return spec.state;
  if (path.startsWith("/state/") && spec.state) {
    const statePath = path.slice("/state".length);
    return getByPath(spec.state, statePath);
  }
  return getByPath(spec, path);
}
function applyPatch(spec, patch) {
  const newSpec = {
    ...spec,
    elements: { ...spec.elements },
    ...spec.state ? { state: { ...spec.state } } : {}
  };
  switch (patch.op) {
    case "add":
    case "replace": {
      setSpecValue(newSpec, patch.path, patch.value);
      break;
    }
    case "remove": {
      removeSpecValue(newSpec, patch.path);
      break;
    }
    case "move": {
      if (!patch.from) break;
      const moveValue = getSpecValue(newSpec, patch.from);
      removeSpecValue(newSpec, patch.from);
      setSpecValue(newSpec, patch.path, moveValue);
      break;
    }
    case "copy": {
      if (!patch.from) break;
      const copyValue = getSpecValue(newSpec, patch.from);
      setSpecValue(newSpec, patch.path, copyValue);
      break;
    }
  }
  return newSpec;
}
function useUIStream(options) {
  const [spec, setSpec] = createSignal(null);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [error, setError] = createSignal(null);
  const [usage, setUsage] = createSignal(null);
  const [rawLines, setRawLines] = createSignal([]);
  let abortController = null;
  const clear = () => {
    setSpec(null);
    setError(null);
  };
  const send = async (prompt, context) => {
    abortController?.abort();
    abortController = new AbortController();
    setIsStreaming(true);
    setError(null);
    setUsage(null);
    setRawLines([]);
    const previousSpec = context?.previousSpec;
    let currentSpec = previousSpec && previousSpec.root ? { ...previousSpec, elements: { ...previousSpec.elements } } : { root: "", elements: {} };
    setSpec(currentSpec);
    try {
      const response = await fetch(options.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          context,
          currentSpec
        }),
        signal: abortController.signal
      });
      if (!response.ok) {
        let errorMessage = `HTTP error: ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.message) {
            errorMessage = errorData.message;
          } else if (errorData.error) {
            errorMessage = errorData.error;
          }
        } catch {
        }
        throw new Error(errorMessage);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const result = parseLine(trimmed);
          if (!result) continue;
          if (result.type === "usage") {
            setUsage(result.usage);
          } else {
            setRawLines((prev) => [...prev, trimmed]);
            currentSpec = applyPatch(currentSpec, result.patch);
            setSpec({ ...currentSpec });
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        const result = parseLine(trimmed);
        if (result) {
          if (result.type === "usage") {
            setUsage(result.usage);
          } else {
            setRawLines((prev) => [...prev, trimmed]);
            currentSpec = applyPatch(currentSpec, result.patch);
            setSpec({ ...currentSpec });
          }
        }
      }
      options.onComplete?.(currentSpec);
    } catch (err) {
      if (err.name === "AbortError") {
        return;
      }
      const resolvedError = err instanceof Error ? err : new Error(String(err));
      setError(resolvedError);
      options.onError?.(resolvedError);
    } finally {
      setIsStreaming(false);
    }
  };
  onCleanup(() => {
    abortController?.abort();
  });
  return {
    get spec() {
      return spec();
    },
    get isStreaming() {
      return isStreaming();
    },
    get error() {
      return error();
    },
    get usage() {
      return usage();
    },
    get rawLines() {
      return rawLines();
    },
    send,
    clear
  };
}
function flatToTree(elements) {
  const elementMap = {};
  let root = "";
  for (const element of elements) {
    elementMap[element.key] = {
      type: element.type,
      props: element.props,
      children: [],
      visible: element.visible
    };
  }
  for (const element of elements) {
    if (element.parentKey) {
      const parent = elementMap[element.parentKey];
      if (parent) {
        if (!parent.children) {
          parent.children = [];
        }
        parent.children.push(element.key);
      }
    } else {
      root = element.key;
    }
  }
  return { root, elements: elementMap };
}
function useBoundProp(propValue, bindingPath) {
  const { set } = useStateStore();
  const setValue = (value) => {
    if (bindingPath) set(bindingPath, value);
  };
  return [propValue, setValue];
}
function isSpecDataPart(data) {
  if (typeof data !== "object" || data === null) return false;
  const obj = data;
  switch (obj.type) {
    case "patch":
      return typeof obj.patch === "object" && obj.patch !== null;
    case "flat":
    case "nested":
      return typeof obj.spec === "object" && obj.spec !== null;
    default:
      return false;
  }
}
function buildSpecFromParts(parts) {
  const spec = { root: "", elements: {} };
  let hasSpec = false;
  for (const part of parts) {
    if (part.type === SPEC_DATA_PART_TYPE) {
      if (!isSpecDataPart(part.data)) continue;
      const payload = part.data;
      if (payload.type === "patch") {
        hasSpec = true;
        applySpecPatch(spec, payload.patch);
      } else if (payload.type === "flat") {
        hasSpec = true;
        Object.assign(spec, payload.spec);
      } else if (payload.type === "nested") {
        hasSpec = true;
        const flat = nestedToFlat(payload.spec);
        Object.assign(spec, flat);
      }
    }
  }
  return hasSpec ? spec : null;
}
function getTextFromParts(parts) {
  return parts.filter(
    (p) => p.type === "text" && typeof p.text === "string"
  ).map((p) => p.text.trim()).filter(Boolean).join("\n\n");
}
function useJsonRenderMessage(getParts) {
  const result = createMemo(() => {
    const parts = getParts();
    return {
      spec: buildSpecFromParts(parts),
      text: getTextFromParts(parts)
    };
  });
  return {
    get spec() {
      return result().spec;
    },
    get text() {
      return result().text;
    },
    get hasSpec() {
      const s = result().spec;
      return s !== null && Object.keys(s.elements || {}).length > 0;
    }
  };
}
var chatMessageIdCounter = 0;
function generateChatId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  chatMessageIdCounter += 1;
  return `msg-${Date.now()}-${chatMessageIdCounter}`;
}
function useChatUI(options) {
  const [messages, setMessages] = createSignal([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [error, setError] = createSignal(null);
  let abortController = null;
  const clear = () => {
    setMessages([]);
    setError(null);
  };
  const send = async (text) => {
    if (!text.trim()) return;
    abortController?.abort();
    abortController = new AbortController();
    const userMessage = {
      id: generateChatId(),
      role: "user",
      text: text.trim(),
      spec: null
    };
    const assistantId = generateChatId();
    const assistantMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      spec: null
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setIsStreaming(true);
    setError(null);
    const historyForApi = [
      ...messages().filter((m) => m.id !== userMessage.id && m.id !== assistantId).map((m) => ({
        role: m.role,
        content: m.text
      })),
      { role: "user", content: text.trim() }
    ];
    let accumulatedText = "";
    let currentSpec = { root: "", elements: {} };
    let hasSpec = false;
    try {
      const response = await fetch(options.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi }),
        signal: abortController.signal
      });
      if (!response.ok) {
        let errorMessage = `HTTP error: ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.message) {
            errorMessage = errorData.message;
          } else if (errorData.error) {
            errorMessage = errorData.error;
          }
        } catch {
        }
        throw new Error(errorMessage);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }
      const decoder = new TextDecoder();
      const parser = createMixedStreamParser({
        onPatch(patch) {
          hasSpec = true;
          applySpecPatch(currentSpec, patch);
          setMessages(
            (prev) => prev.map(
              (m) => m.id === assistantId ? {
                ...m,
                spec: {
                  root: currentSpec.root,
                  elements: { ...currentSpec.elements },
                  ...currentSpec.state ? { state: { ...currentSpec.state } } : {}
                }
              } : m
            )
          );
        },
        onText(line) {
          accumulatedText += (accumulatedText ? "\n" : "") + line;
          setMessages(
            (prev) => prev.map(
              (m) => m.id === assistantId ? { ...m, text: accumulatedText } : m
            )
          );
        }
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.flush();
      const finalMessage = {
        id: assistantId,
        role: "assistant",
        text: accumulatedText,
        spec: hasSpec ? {
          root: currentSpec.root,
          elements: { ...currentSpec.elements },
          ...currentSpec.state ? { state: { ...currentSpec.state } } : {}
        } : null
      };
      options.onComplete?.(finalMessage);
    } catch (err) {
      if (err.name === "AbortError") {
        return;
      }
      const resolvedError = err instanceof Error ? err : new Error(String(err));
      setError(resolvedError);
      setMessages(
        (prev) => prev.filter((m) => m.id !== assistantId || m.text.length > 0)
      );
      options.onError?.(resolvedError);
    } finally {
      setIsStreaming(false);
    }
  };
  onCleanup(() => {
    abortController?.abort();
  });
  return {
    get messages() {
      return messages();
    },
    get isStreaming() {
      return isStreaming();
    },
    get error() {
      return error();
    },
    send,
    clear
  };
}
export {
  ActionProvider,
  ConfirmDialog,
  JSONUIProvider,
  Renderer,
  RepeatScopeProvider,
  StateProvider,
  ValidationProvider,
  VisibilityProvider,
  buildSpecFromParts,
  createRenderer,
  createStateStore,
  defineRegistry,
  elementTreeSchema,
  flatToTree,
  getTextFromParts,
  schema,
  useAction,
  useActions,
  useBoundProp,
  useChatUI,
  useFieldValidation,
  useIsVisible,
  useJsonRenderMessage,
  useOptionalValidation,
  useRepeatScope,
  useStateBinding,
  useStateStore,
  useStateValue,
  useUIStream,
  useValidation,
  useVisibility
};
