function $constructor(name, initializer2, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: /* @__PURE__ */ new Set()
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer2(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a2;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}
class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
const globalConfig = {};
function config(newConfig) {
  return globalConfig;
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  return {
    get value() {
      {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
const EVALUATING = Symbol("evaluating");
function defineLazy(object2, key, getter) {
  let value = void 0;
  Object.defineProperty(object2, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object2, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject$1(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject$1(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
const propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
const NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject$1(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = schema._zod.def.shape;
    for (const key in shape) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject$1(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
    // delete existing checks
  });
  return clone(a, def);
}
function partial(Class, schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    }
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a2;
    (_a2 = iss).path ?? (_a2.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
const initializer$1 = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue2) => issue2.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error2) => {
    for (const issue2 of error2.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues });
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}
const _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
const safeParse$1 = /* @__PURE__ */ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
const safeParseAsync$1 = /* @__PURE__ */ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
const _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
const cuid = /^[cC][^\s-]{8,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const uuid = (version2) => {
  if (!version2)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version2}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time$1(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
  const time2 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time2}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const _null$2 = /^null$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
const $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a2;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a2 = inst._zod).onattach ?? (_a2.onattach = []);
});
const numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
const $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a2;
    (_a2 = inst2._zod.bag).multipleOf ?? (_a2.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
const $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a2, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a2 = inst._zod).check ?? (_a2.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {
    });
});
const $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});
class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split("\n").filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join("\n"));
  }
}
const version = {
  major: 4,
  minor: 3,
  patch: 6
};
const $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a2;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse$1(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
const $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
const $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
const $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
const $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === void 0)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
const $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
const $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: def.hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
const $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
const $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
const $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
const $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime$1(def));
  $ZodStringFormat.init(inst, def);
});
const $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date$1);
  $ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time$1(def));
  $ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration$1);
  $ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv6`;
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
const $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error();
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error();
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error();
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error();
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
const $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64";
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base642 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base642.padEnd(Math.ceil(base642.length / 4) * 4, "=");
  return isValidBase64(padded);
}
const $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64url";
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
const $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
const $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
const $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
const $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean$1;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
const $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null$2;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
const $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
const $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
const $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index2) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index2, result.issues));
  }
  final.value[index2] = result.value;
}
const $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalOut) {
  if (result.issues.length) {
    if (isOptionalOut && !(key in input)) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === void 0) {
    if (key in input) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
const $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject$1 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject$1(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
const $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = /* @__PURE__ */ Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      const schema = shape[key];
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(key)};`);
      if (isOptionalOut) {
        doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject$1 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval$1 = allowsEval;
  const fastEnabled = jit && allowsEval$1.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject$1(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
const $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
const $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject$1(a) && isPlainObject$1(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index2 = 0; index2 < a.length; index2++) {
      const itemA = a[index2];
      const itemB = b[index2];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index2, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = /* @__PURE__ */ new Map();
  let unrecIssue;
  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ?? (unrecIssue = iss);
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).l = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).r = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length && unrecIssue) {
    result.issues.push({ ...unrecIssue, keys: bothKeys });
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
const $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject$1(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values) {
      payload.value = {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number$1.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
const $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
const $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
const $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError();
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === void 0) {
    return { issues: [], value: void 0 };
  }
  return result;
}
const $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
const $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
const $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
const $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === void 0) {
    payload.value = def.defaultValue;
  }
  return payload;
}
const $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
const $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
const $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
const $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
const $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
  defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
const $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType?._zod?.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType?._zod?.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType?._zod?.optin ?? void 0);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType?._zod?.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
const $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
var _a;
class $ZodRegistry {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : void 0;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _null$1(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _any(Class) {
  return new Class({
    type: "any"
  });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
  return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
  return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
  return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn) {
  const ch = /* @__PURE__ */ _check((payload) => {
    payload.addIssue = (issue$1) => {
      if (typeof issue$1 === "string") {
        payload.issues.push(issue(issue$1, payload.value, ch._zod.def));
      } else {
        const _issue = issue$1;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {
    }),
    io: params?.io ?? "output",
    counter: 0,
    seen: /* @__PURE__ */ new Map(),
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    external: params?.external ?? void 0
  };
}
function process(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a2;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: void 0, path: _params.path };
  ctx.seen.set(schema, result);
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      process(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    Object.assign(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && result.schema._prefault)
    (_a2 = result.schema).default ?? (_a2.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const idToSchema = /* @__PURE__ */ new Map();
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id2) => id2);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) {
      return { ref: "#" };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + defId };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema2 = seen.schema;
    for (const key in schema2) {
      delete schema2[key];
    }
    schema2.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
        continue;
      }
    }
  }
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema2 = seen.def ?? seen.schema;
    const _cached = { ...schema2 };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema2.allOf = schema2.allOf ?? [];
        schema2.allOf.push(refSchema);
      } else {
        Object.assign(schema2, refSchema);
      }
      Object.assign(schema2, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema2[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema2[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema2.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema2) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema2[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema2,
      path: seen.path ?? []
    });
  };
  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") ;
  else ;
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  Object.assign(result, root.def ?? root.schema);
  const defs = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      defs[seen.defId] = seen.def;
    }
  }
  if (ctx.external) ;
  else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  process(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  process(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
const formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
  // do not set
};
const stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time") {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const regexes = [...patterns];
    if (regexes.length === 1)
      json.pattern = regexes[0].source;
    else if (regexes.length > 1) {
      json.allOf = [
        ...regexes.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
const numberProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
  if (typeof format === "string" && format.includes("int"))
    json.type = "integer";
  else
    json.type = "number";
  if (typeof exclusiveMinimum === "number") {
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  }
  if (typeof minimum === "number") {
    json.minimum = minimum;
    if (typeof exclusiveMinimum === "number" && ctx.target !== "draft-04") {
      if (exclusiveMinimum >= minimum)
        delete json.minimum;
      else
        delete json.exclusiveMinimum;
    }
  }
  if (typeof exclusiveMaximum === "number") {
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  }
  if (typeof maximum === "number") {
    json.maximum = maximum;
    if (typeof exclusiveMaximum === "number" && ctx.target !== "draft-04") {
      if (exclusiveMaximum <= maximum)
        delete json.maximum;
      else
        delete json.exclusiveMaximum;
    }
  }
  if (typeof multipleOf === "number")
    json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
const nullProcessor = (_schema, ctx, json, _params) => {
  if (ctx.target === "openapi-3.0") {
    json.type = "string";
    json.nullable = true;
    json.enum = [null];
  } else {
    json.type = "null";
  }
};
const neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
const anyProcessor = (_schema, _ctx, _json, _params) => {
};
const unknownProcessor = (_schema, _ctx, _json, _params) => {
};
const enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
const literalProcessor = (schema, ctx, json, _params) => {
  const def = schema._zod.def;
  const vals = [];
  for (const val of def.values) {
    if (val === void 0) {
      if (ctx.unrepresentable === "throw") {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      }
    } else if (typeof val === "bigint") {
      if (ctx.unrepresentable === "throw") {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      } else {
        vals.push(Number(val));
      }
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) ;
  else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
const customProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Custom types cannot be represented in JSON Schema");
  }
};
const transformProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Transforms cannot be represented in JSON Schema");
  }
};
const arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = process(def.element, ctx, { ...params, path: [...params.path, "items"] });
};
const objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  json.properties = {};
  const shape = def.shape;
  for (const key in shape) {
    json.properties[key] = process(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    });
  }
  const allKeys = new Set(Object.keys(shape));
  const requiredKeys = new Set([...allKeys].filter((key) => {
    const v = def.shape[key]._zod;
    if (ctx.io === "input") {
      return v.optin === void 0;
    } else {
      return v.optout === void 0;
    }
  }));
  if (requiredKeys.size > 0) {
    json.required = Array.from(requiredKeys);
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = process(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
const unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => process(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
const intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = process(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = process(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
};
const recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const keyBag = keyType._zod.bag;
  const patterns = keyBag?.patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = process(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      json.patternProperties[pattern.source] = valueSchema;
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = process(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
    }
    json.additionalProperties = process(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  if (keyValues) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues;
    }
  }
};
const nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io === "input")
    json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(void 0);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
  process(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
const lazyProcessor = (schema, ctx, _json, params) => {
  const innerType = schema._zod.innerType;
  process(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
const ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime(params) {
  return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date(params) {
  return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
const ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time(params) {
  return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
const ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration(params) {
  return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
const initializer = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
      // enumerable: false,
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
      // enumerable: false,
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
      // enumerable: false,
    }
  });
};
const ZodRealError = $constructor("ZodError", initializer, {
  Parent: Error
});
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
const ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  Object.assign(inst["~standard"], {
    jsonSchema: {
      input: createStandardJSONSchemaMethod(inst, "input"),
      output: createStandardJSONSchemaMethod(inst, "output")
    }
  });
  inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks) => {
    return inst.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), {
      parent: true
    });
  };
  inst.with = inst.check;
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = ((reg, meta) => {
    reg.add(inst, meta);
    return inst;
  });
  inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode(inst, data, params);
  inst.decode = (data, params) => decode(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
  inst.refine = (check2, params) => inst.check(refine(check2, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(/* @__PURE__ */ _overwrite(fn));
  inst.optional = () => optional(inst);
  inst.exactOptional = () => exactOptional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(void 0).success;
  inst.isNullable = () => inst.safeParse(null).success;
  inst.apply = (fn) => fn(inst);
  return inst;
});
const _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(/* @__PURE__ */ _regex(...args));
  inst.includes = (...args) => inst.check(/* @__PURE__ */ _includes(...args));
  inst.startsWith = (...args) => inst.check(/* @__PURE__ */ _startsWith(...args));
  inst.endsWith = (...args) => inst.check(/* @__PURE__ */ _endsWith(...args));
  inst.min = (...args) => inst.check(/* @__PURE__ */ _minLength(...args));
  inst.max = (...args) => inst.check(/* @__PURE__ */ _maxLength(...args));
  inst.length = (...args) => inst.check(/* @__PURE__ */ _length(...args));
  inst.nonempty = (...args) => inst.check(/* @__PURE__ */ _minLength(1, ...args));
  inst.lowercase = (params) => inst.check(/* @__PURE__ */ _lowercase(params));
  inst.uppercase = (params) => inst.check(/* @__PURE__ */ _uppercase(params));
  inst.trim = () => inst.check(/* @__PURE__ */ _trim());
  inst.normalize = (...args) => inst.check(/* @__PURE__ */ _normalize(...args));
  inst.toLowerCase = () => inst.check(/* @__PURE__ */ _toLowerCase());
  inst.toUpperCase = () => inst.check(/* @__PURE__ */ _toUpperCase());
  inst.slugify = () => inst.check(/* @__PURE__ */ _slugify());
});
const ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
  inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
  inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
  inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime(params));
  inst.date = (params) => inst.check(date(params));
  inst.time = (params) => inst.check(time(params));
  inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
  return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
const ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
const ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json);
  inst.gt = (value, params) => inst.check(/* @__PURE__ */ _gt(value, params));
  inst.gte = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
  inst.min = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
  inst.lt = (value, params) => inst.check(/* @__PURE__ */ _lt(value, params));
  inst.lte = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
  inst.max = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(/* @__PURE__ */ _gt(0, params));
  inst.nonnegative = (params) => inst.check(/* @__PURE__ */ _gte(0, params));
  inst.negative = (params) => inst.check(/* @__PURE__ */ _lt(0, params));
  inst.nonpositive = (params) => inst.check(/* @__PURE__ */ _lte(0, params));
  inst.multipleOf = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
  inst.step = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number(params) {
  return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json);
});
function boolean(params) {
  return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json);
});
function _null(params) {
  return /* @__PURE__ */ _null$1(ZodNull, params);
}
const ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => anyProcessor();
});
function any() {
  return /* @__PURE__ */ _any(ZodAny);
}
const ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor();
});
function unknown() {
  return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json);
});
function never(params) {
  return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(/* @__PURE__ */ _minLength(minLength, params));
  inst.nonempty = (params) => inst.check(/* @__PURE__ */ _minLength(1, params));
  inst.max = (maxLength, params) => inst.check(/* @__PURE__ */ _maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(/* @__PURE__ */ _length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  defineLazy(inst, "shape", () => {
    return def.shape;
  });
  inst.keyof = () => _enum(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: void 0 });
  inst.extend = (incoming) => {
    return extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return safeExtend(inst, incoming);
  };
  inst.merge = (other) => merge(inst, other);
  inst.pick = (mask) => pick(inst, mask);
  inst.omit = (mask) => omit(inst, mask);
  inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
const ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
const ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
const ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
const ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
const ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
const ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue$1) => {
      if (typeof issue$1 === "string") {
        payload.issues.push(issue(issue$1, payload.value, def));
      } else {
        const _issue = issue$1;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
const ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
const ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
const ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
const ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
const ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
const ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
const ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
const ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
    // ...util.normalizeParams(params),
  });
}
const ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
const ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => lazyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
const ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx);
});
function refine(fn, _params = {}) {
  return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return /* @__PURE__ */ _superRefine(fn);
}
var DynamicValueSchema = union([
  string(),
  number(),
  boolean(),
  _null(),
  object({ $state: string() })
]);
var DynamicStringSchema = union([
  string(),
  object({ $state: string() })
]);
var DynamicNumberSchema = union([
  number(),
  object({ $state: string() })
]);
var DynamicBooleanSchema = union([
  boolean(),
  object({ $state: string() })
]);
function resolveDynamicValue(value, stateModel) {
  if (value === null || value === void 0) {
    return void 0;
  }
  if (typeof value === "object" && "$state" in value) {
    return getByPath(stateModel, value.$state);
  }
  return value;
}
function unescapeJsonPointer(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
function parseJsonPointer(path) {
  const raw = path.startsWith("/") ? path.slice(1).split("/") : path.split("/");
  return raw.map(unescapeJsonPointer);
}
function getByPath(obj, path) {
  if (!path || path === "/") {
    return obj;
  }
  const segments = parseJsonPointer(path);
  let current = obj;
  for (const segment of segments) {
    if (current === null || current === void 0) {
      return void 0;
    }
    if (Array.isArray(current)) {
      const index2 = parseInt(segment, 10);
      current = current[index2];
    } else if (typeof current === "object") {
      current = current[segment];
    } else {
      return void 0;
    }
  }
  return current;
}
function isNumericIndex(str) {
  return /^\d+$/.test(str);
}
function setByPath(obj, path, value) {
  const segments = parseJsonPointer(path);
  if (segments.length === 0) return;
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const nextIsNumeric = nextSegment !== void 0 && (isNumericIndex(nextSegment) || nextSegment === "-");
    if (Array.isArray(current)) {
      const index2 = parseInt(segment, 10);
      if (current[index2] === void 0 || typeof current[index2] !== "object") {
        current[index2] = nextIsNumeric ? [] : {};
      }
      current = current[index2];
    } else {
      if (!(segment in current) || typeof current[segment] !== "object") {
        current[segment] = nextIsNumeric ? [] : {};
      }
      current = current[segment];
    }
  }
  const lastSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (lastSegment === "-") {
      current.push(value);
    } else {
      const index2 = parseInt(lastSegment, 10);
      current[index2] = value;
    }
  } else {
    current[lastSegment] = value;
  }
}
function addByPath(obj, path, value) {
  const segments = parseJsonPointer(path);
  if (segments.length === 0) return;
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const nextIsNumeric = nextSegment !== void 0 && (isNumericIndex(nextSegment) || nextSegment === "-");
    if (Array.isArray(current)) {
      const index2 = parseInt(segment, 10);
      if (current[index2] === void 0 || typeof current[index2] !== "object") {
        current[index2] = nextIsNumeric ? [] : {};
      }
      current = current[index2];
    } else {
      if (!(segment in current) || typeof current[segment] !== "object") {
        current[segment] = nextIsNumeric ? [] : {};
      }
      current = current[segment];
    }
  }
  const lastSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (lastSegment === "-") {
      current.push(value);
    } else {
      const index2 = parseInt(lastSegment, 10);
      current.splice(index2, 0, value);
    }
  } else {
    current[lastSegment] = value;
  }
}
function removeByPath(obj, path) {
  const segments = parseJsonPointer(path);
  if (segments.length === 0) return;
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (Array.isArray(current)) {
      const index2 = parseInt(segment, 10);
      if (current[index2] === void 0 || typeof current[index2] !== "object") {
        return;
      }
      current = current[index2];
    } else {
      if (!(segment in current) || typeof current[segment] !== "object") {
        return;
      }
      current = current[segment];
    }
  }
  const lastSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const index2 = parseInt(lastSegment, 10);
    if (index2 >= 0 && index2 < current.length) {
      current.splice(index2, 1);
    }
  } else {
    delete current[lastSegment];
  }
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a;
  const bObj = b;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}
function findFormValue(fieldName, params, state) {
  if (params?.[fieldName] !== void 0) {
    const val = params[fieldName];
    if (typeof val !== "string" || !val.includes(".")) {
      return val;
    }
  }
  if (params) {
    for (const key of Object.keys(params)) {
      if (key.endsWith(`.${fieldName}`)) {
        const val = params[key];
        if (typeof val !== "string" || !val.includes(".")) {
          return val;
        }
      }
    }
  }
  if (state) {
    for (const key of Object.keys(state)) {
      if (key === fieldName || key.endsWith(`.${fieldName}`)) {
        return state[key];
      }
    }
    const val = getByPath(state, fieldName);
    if (val !== void 0) {
      return val;
    }
  }
  return void 0;
}
function parseSpecStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const patch = JSON.parse(trimmed);
    if (patch.op && patch.path !== void 0) {
      return patch;
    }
    return null;
  } catch {
    return null;
  }
}
function applySpecStreamPatch(obj, patch) {
  switch (patch.op) {
    case "add":
      addByPath(obj, patch.path, patch.value);
      break;
    case "replace":
      setByPath(obj, patch.path, patch.value);
      break;
    case "remove":
      removeByPath(obj, patch.path);
      break;
    case "move": {
      if (!patch.from) break;
      const moveValue = getByPath(obj, patch.from);
      removeByPath(obj, patch.from);
      addByPath(obj, patch.path, moveValue);
      break;
    }
    case "copy": {
      if (!patch.from) break;
      const copyValue = getByPath(obj, patch.from);
      addByPath(obj, patch.path, copyValue);
      break;
    }
    case "test": {
      const actual = getByPath(obj, patch.path);
      if (!deepEqual(actual, patch.value)) {
        throw new Error(
          `Test operation failed: value at "${patch.path}" does not match`
        );
      }
      break;
    }
  }
  return obj;
}
function applySpecPatch(spec, patch) {
  applySpecStreamPatch(spec, patch);
  return spec;
}
function nestedToFlat(nested) {
  const elements = {};
  let counter = 0;
  function walk(node) {
    const key = `el-${counter++}`;
    const { type, props, children: rawChildren, ...rest } = node;
    const childKeys = [];
    if (Array.isArray(rawChildren)) {
      for (const child of rawChildren) {
        if (child && typeof child === "object" && "type" in child) {
          childKeys.push(walk(child));
        }
      }
    }
    const element = {
      type: type ?? "unknown",
      props: props ?? {},
      children: childKeys
    };
    for (const [k, v] of Object.entries(rest)) {
      if (k !== "state" && v !== void 0) {
        element[k] = v;
      }
    }
    elements[key] = element;
    return key;
  }
  const root = walk(nested);
  const spec = { root, elements };
  if (nested.state && typeof nested.state === "object" && !Array.isArray(nested.state)) {
    spec.state = nested.state;
  }
  return spec;
}
function compileSpecStream(stream, initial = {}) {
  const lines = stream.split("\n");
  const result = { ...initial };
  for (const line of lines) {
    const patch = parseSpecStreamLine(line);
    if (patch) {
      applySpecStreamPatch(result, patch);
    }
  }
  return result;
}
function createSpecStreamCompiler(initial = {}) {
  let result = { ...initial };
  let buffer = "";
  const appliedPatches = [];
  const processedLines = /* @__PURE__ */ new Set();
  return {
    push(chunk) {
      buffer += chunk;
      const newPatches = [];
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || processedLines.has(trimmed)) continue;
        processedLines.add(trimmed);
        const patch = parseSpecStreamLine(trimmed);
        if (patch) {
          applySpecStreamPatch(result, patch);
          appliedPatches.push(patch);
          newPatches.push(patch);
        }
      }
      if (newPatches.length > 0) {
        result = { ...result };
      }
      return { result, newPatches };
    },
    getResult() {
      if (buffer.trim()) {
        const patch = parseSpecStreamLine(buffer);
        if (patch && !processedLines.has(buffer.trim())) {
          processedLines.add(buffer.trim());
          applySpecStreamPatch(result, patch);
          appliedPatches.push(patch);
          result = { ...result };
        }
        buffer = "";
      }
      return result;
    },
    getPatches() {
      return [...appliedPatches];
    },
    reset(newInitial = {}) {
      result = { ...newInitial };
      buffer = "";
      appliedPatches.length = 0;
      processedLines.clear();
    }
  };
}
function createMixedStreamParser(callbacks) {
  let buffer = "";
  let inSpecFence = false;
  function processLine(line) {
    const trimmed = line.trim();
    if (!inSpecFence && trimmed.startsWith("```spec")) {
      inSpecFence = true;
      return;
    }
    if (inSpecFence && trimmed === "```") {
      inSpecFence = false;
      return;
    }
    if (!trimmed) return;
    if (inSpecFence) {
      const patch2 = parseSpecStreamLine(trimmed);
      if (patch2) {
        callbacks.onPatch(patch2);
      }
      return;
    }
    const patch = parseSpecStreamLine(trimmed);
    if (patch) {
      callbacks.onPatch(patch);
    } else {
      callbacks.onText(line);
    }
  }
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    },
    flush() {
      if (buffer.trim()) {
        processLine(buffer);
      }
      buffer = "";
    }
  };
}
var SPEC_FENCE_OPEN = "```spec";
var SPEC_FENCE_CLOSE = "```";
function createJsonRenderTransform() {
  let lineBuffer = "";
  let currentTextId = "";
  let buffering = false;
  let inSpecFence = false;
  let inTextBlock = false;
  let textIdCounter = 0;
  function closeTextBlock(controller) {
    if (inTextBlock) {
      controller.enqueue({ type: "text-end", id: currentTextId });
      inTextBlock = false;
    }
  }
  function ensureTextBlock(controller) {
    if (!inTextBlock) {
      textIdCounter++;
      currentTextId = String(textIdCounter);
      controller.enqueue({ type: "text-start", id: currentTextId });
      inTextBlock = true;
    }
  }
  function emitTextDelta(delta, controller) {
    ensureTextBlock(controller);
    controller.enqueue({ type: "text-delta", id: currentTextId, delta });
  }
  function emitPatch(patch, controller) {
    closeTextBlock(controller);
    controller.enqueue({
      type: SPEC_DATA_PART_TYPE,
      data: { type: "patch", patch }
    });
  }
  function flushBuffer(controller) {
    if (!lineBuffer) return;
    const trimmed = lineBuffer.trim();
    if (inSpecFence) {
      if (trimmed) {
        const patch = parseSpecStreamLine(trimmed);
        if (patch) emitPatch(patch, controller);
      }
      lineBuffer = "";
      buffering = false;
      return;
    }
    if (trimmed) {
      const patch = parseSpecStreamLine(trimmed);
      if (patch) {
        emitPatch(patch, controller);
      } else {
        emitTextDelta(lineBuffer, controller);
      }
    } else {
      emitTextDelta(lineBuffer, controller);
    }
    lineBuffer = "";
    buffering = false;
  }
  function processCompleteLine(line, controller) {
    const trimmed = line.trim();
    if (!inSpecFence && trimmed.startsWith(SPEC_FENCE_OPEN)) {
      inSpecFence = true;
      return;
    }
    if (inSpecFence && trimmed === SPEC_FENCE_CLOSE) {
      inSpecFence = false;
      return;
    }
    if (inSpecFence) {
      if (trimmed) {
        const patch2 = parseSpecStreamLine(trimmed);
        if (patch2) emitPatch(patch2, controller);
      }
      return;
    }
    if (!trimmed) {
      emitTextDelta("\n", controller);
      return;
    }
    const patch = parseSpecStreamLine(trimmed);
    if (patch) {
      emitPatch(patch, controller);
    } else {
      emitTextDelta(line + "\n", controller);
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      switch (chunk.type) {
        case "text-start": {
          const id = chunk.id;
          const idNum = parseInt(id, 10);
          if (!isNaN(idNum) && idNum >= textIdCounter) {
            textIdCounter = idNum;
          }
          currentTextId = id;
          inTextBlock = true;
          controller.enqueue(chunk);
          break;
        }
        case "text-delta": {
          const delta = chunk;
          const text = delta.delta;
          for (let i = 0; i < text.length; i++) {
            const ch = text.charAt(i);
            if (ch === "\n") {
              if (buffering) {
                processCompleteLine(lineBuffer, controller);
                lineBuffer = "";
                buffering = false;
              } else {
                if (!inSpecFence) {
                  emitTextDelta("\n", controller);
                }
              }
            } else if (lineBuffer.length === 0 && !buffering) {
              if (inSpecFence || ch === "{" || ch === "`") {
                buffering = true;
                lineBuffer += ch;
              } else {
                emitTextDelta(ch, controller);
              }
            } else if (buffering) {
              lineBuffer += ch;
            } else {
              emitTextDelta(ch, controller);
            }
          }
          break;
        }
        case "text-end": {
          flushBuffer(controller);
          if (inTextBlock) {
            controller.enqueue({ type: "text-end", id: currentTextId });
            inTextBlock = false;
          }
          break;
        }
        default: {
          controller.enqueue(chunk);
          break;
        }
      }
    },
    flush(controller) {
      flushBuffer(controller);
      closeTextBlock(controller);
    }
  });
}
var SPEC_DATA_PART = "spec";
var SPEC_DATA_PART_TYPE = `data-${SPEC_DATA_PART}`;
function pipeJsonRender(stream) {
  return stream.pipeThrough(
    createJsonRenderTransform()
  );
}
function immutableSetByPath(root, path, value) {
  const segments = parseJsonPointer(path);
  if (segments.length === 0) return root;
  const result = { ...root };
  let current = result;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const child = current[seg];
    if (Array.isArray(child)) {
      current[seg] = [...child];
    } else if (child !== null && typeof child === "object") {
      current[seg] = { ...child };
    } else {
      const nextSeg = segments[i + 1];
      current[seg] = nextSeg !== void 0 && /^\d+$/.test(nextSeg) ? [] : {};
    }
    current = current[seg];
  }
  const lastSeg = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (lastSeg === "-") {
      current.push(value);
    } else {
      current[parseInt(lastSeg, 10)] = value;
    }
  } else {
    current[lastSeg] = value;
  }
  return result;
}
function createStateStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = /* @__PURE__ */ new Set();
  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }
  return {
    get(path) {
      return getByPath(state, path);
    },
    set(path, value) {
      if (getByPath(state, path) === value) return;
      state = immutableSetByPath(state, path, value);
      notify();
    },
    update(updates) {
      let changed = false;
      let next = state;
      for (const [path, value] of Object.entries(updates)) {
        if (getByPath(next, path) !== value) {
          next = immutableSetByPath(next, path, value);
          changed = true;
        }
      }
      if (!changed) return;
      state = next;
      notify();
    },
    getSnapshot() {
      return state;
    },
    getServerSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
var MAX_FLATTEN_DEPTH = 20;
function flattenToPointers(obj, prefix = "", _depth = 0, _seen, _warned) {
  const seen = _seen ?? /* @__PURE__ */ new Set();
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const pointer = `${prefix}/${key}`;
    if (_depth < MAX_FLATTEN_DEPTH && value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && !seen.has(value)) {
      seen.add(value);
      Object.assign(
        result,
        flattenToPointers(
          value,
          pointer,
          _depth + 1,
          seen
        )
      );
    } else {
      result[pointer] = value;
    }
  }
  return result;
}
var numericOrStateRef = union([
  number(),
  object({ $state: string() })
]);
var comparisonOps = {
  eq: unknown().optional(),
  neq: unknown().optional(),
  gt: numericOrStateRef.optional(),
  gte: numericOrStateRef.optional(),
  lt: numericOrStateRef.optional(),
  lte: numericOrStateRef.optional(),
  not: literal(true).optional()
};
var StateConditionSchema = object({
  $state: string(),
  ...comparisonOps
});
var ItemConditionSchema = object({
  $item: string(),
  ...comparisonOps
});
var IndexConditionSchema = object({
  $index: literal(true),
  ...comparisonOps
});
var SingleConditionSchema = union([
  StateConditionSchema,
  ItemConditionSchema,
  IndexConditionSchema
]);
var VisibilityConditionSchema = lazy(
  () => union([
    boolean(),
    SingleConditionSchema,
    array(SingleConditionSchema),
    object({ $and: array(VisibilityConditionSchema) }),
    object({ $or: array(VisibilityConditionSchema) })
  ])
);
function resolveComparisonValue(value, ctx) {
  if (typeof value === "object" && value !== null) {
    if ("$state" in value && typeof value.$state === "string") {
      return getByPath(ctx.stateModel, value.$state);
    }
  }
  return value;
}
function isItemCondition(cond) {
  return "$item" in cond;
}
function isIndexCondition(cond) {
  return "$index" in cond;
}
function resolveConditionValue(cond, ctx) {
  if (isIndexCondition(cond)) {
    return ctx.repeatIndex;
  }
  if (isItemCondition(cond)) {
    if (ctx.repeatItem === void 0) return void 0;
    return cond.$item === "" ? ctx.repeatItem : getByPath(ctx.repeatItem, cond.$item);
  }
  return getByPath(ctx.stateModel, cond.$state);
}
function evaluateCondition(cond, ctx) {
  const value = resolveConditionValue(cond, ctx);
  let result;
  if (cond.eq !== void 0) {
    const rhs = resolveComparisonValue(cond.eq, ctx);
    result = value === rhs;
  } else if (cond.neq !== void 0) {
    const rhs = resolveComparisonValue(cond.neq, ctx);
    result = value !== rhs;
  } else if (cond.gt !== void 0) {
    const rhs = resolveComparisonValue(cond.gt, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value > rhs : false;
  } else if (cond.gte !== void 0) {
    const rhs = resolveComparisonValue(cond.gte, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value >= rhs : false;
  } else if (cond.lt !== void 0) {
    const rhs = resolveComparisonValue(cond.lt, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value < rhs : false;
  } else if (cond.lte !== void 0) {
    const rhs = resolveComparisonValue(cond.lte, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value <= rhs : false;
  } else {
    result = Boolean(value);
  }
  return cond.not === true ? !result : result;
}
function isAndCondition(condition) {
  return typeof condition === "object" && condition !== null && !Array.isArray(condition) && "$and" in condition;
}
function isOrCondition(condition) {
  return typeof condition === "object" && condition !== null && !Array.isArray(condition) && "$or" in condition;
}
function evaluateVisibility(condition, ctx) {
  if (condition === void 0) {
    return true;
  }
  if (typeof condition === "boolean") {
    return condition;
  }
  if (Array.isArray(condition)) {
    return condition.every((c) => evaluateCondition(c, ctx));
  }
  if (isAndCondition(condition)) {
    return condition.$and.every((child) => evaluateVisibility(child, ctx));
  }
  if (isOrCondition(condition)) {
    return condition.$or.some((child) => evaluateVisibility(child, ctx));
  }
  return evaluateCondition(condition, ctx);
}
var visibility = {
  /** Always visible */
  always: true,
  /** Never visible */
  never: false,
  /** Visible when state path is truthy */
  when: (path) => ({ $state: path }),
  /** Visible when state path is falsy */
  unless: (path) => ({ $state: path, not: true }),
  /** Equality check */
  eq: (path, value) => ({
    $state: path,
    eq: value
  }),
  /** Not equal check */
  neq: (path, value) => ({
    $state: path,
    neq: value
  }),
  /** Greater than */
  gt: (path, value) => ({
    $state: path,
    gt: value
  }),
  /** Greater than or equal */
  gte: (path, value) => ({
    $state: path,
    gte: value
  }),
  /** Less than */
  lt: (path, value) => ({
    $state: path,
    lt: value
  }),
  /** Less than or equal */
  lte: (path, value) => ({
    $state: path,
    lte: value
  }),
  /** AND multiple conditions */
  and: (...conditions) => ({
    $and: conditions
  }),
  /** OR multiple conditions */
  or: (...conditions) => ({
    $or: conditions
  })
};
function isStateExpression(value) {
  return typeof value === "object" && value !== null && "$state" in value && typeof value.$state === "string";
}
function isItemExpression(value) {
  return typeof value === "object" && value !== null && "$item" in value && typeof value.$item === "string";
}
function isIndexExpression(value) {
  return typeof value === "object" && value !== null && "$index" in value && value.$index === true;
}
function isBindStateExpression(value) {
  return typeof value === "object" && value !== null && "$bindState" in value && typeof value.$bindState === "string";
}
function isBindItemExpression(value) {
  return typeof value === "object" && value !== null && "$bindItem" in value && typeof value.$bindItem === "string";
}
function isCondExpression(value) {
  return typeof value === "object" && value !== null && "$cond" in value && "$then" in value && "$else" in value;
}
function isComputedExpression(value) {
  return typeof value === "object" && value !== null && "$computed" in value && typeof value.$computed === "string";
}
function isTemplateExpression(value) {
  return typeof value === "object" && value !== null && "$template" in value && typeof value.$template === "string";
}
var WARNED_COMPUTED_MAX = 100;
var warnedComputedFns = /* @__PURE__ */ new Set();
var WARNED_TEMPLATE_MAX = 100;
var warnedTemplatePaths = /* @__PURE__ */ new Set();
function resolveBindItemPath(itemPath, ctx) {
  if (ctx.repeatBasePath == null) {
    console.warn(`$bindItem used outside repeat scope: "${itemPath}"`);
    return void 0;
  }
  if (itemPath === "") return ctx.repeatBasePath;
  return ctx.repeatBasePath + "/" + itemPath;
}
function resolvePropValue(value, ctx) {
  if (value === null || value === void 0) {
    return value;
  }
  if (isStateExpression(value)) {
    return getByPath(ctx.stateModel, value.$state);
  }
  if (isItemExpression(value)) {
    if (ctx.repeatItem === void 0) return void 0;
    return value.$item === "" ? ctx.repeatItem : getByPath(ctx.repeatItem, value.$item);
  }
  if (isIndexExpression(value)) {
    return ctx.repeatIndex;
  }
  if (isBindStateExpression(value)) {
    return getByPath(ctx.stateModel, value.$bindState);
  }
  if (isBindItemExpression(value)) {
    const resolvedPath = resolveBindItemPath(value.$bindItem, ctx);
    if (resolvedPath === void 0) return void 0;
    return getByPath(ctx.stateModel, resolvedPath);
  }
  if (isCondExpression(value)) {
    const result = evaluateVisibility(value.$cond, ctx);
    return resolvePropValue(result ? value.$then : value.$else, ctx);
  }
  if (isComputedExpression(value)) {
    const fn = ctx.functions?.[value.$computed];
    if (!fn) {
      if (!warnedComputedFns.has(value.$computed)) {
        if (warnedComputedFns.size < WARNED_COMPUTED_MAX) {
          warnedComputedFns.add(value.$computed);
        }
        console.warn(`Unknown $computed function: "${value.$computed}"`);
      }
      return void 0;
    }
    const resolvedArgs = {};
    if (value.args) {
      for (const [key, arg] of Object.entries(value.args)) {
        resolvedArgs[key] = resolvePropValue(arg, ctx);
      }
    }
    return fn(resolvedArgs);
  }
  if (isTemplateExpression(value)) {
    return value.$template.replace(
      /\$\{([^}]+)\}/g,
      (_match, rawPath) => {
        let path = rawPath;
        if (!path.startsWith("/")) {
          if (!warnedTemplatePaths.has(path)) {
            if (warnedTemplatePaths.size < WARNED_TEMPLATE_MAX) {
              warnedTemplatePaths.add(path);
            }
            console.warn(
              `$template path "${path}" should be a JSON Pointer starting with "/". Automatically resolving as "/${path}".`
            );
          }
          path = "/" + path;
        }
        const resolved = getByPath(ctx.stateModel, path);
        return resolved != null ? String(resolved) : "";
      }
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePropValue(item, ctx));
  }
  if (typeof value === "object") {
    const resolved = {};
    for (const [key, val] of Object.entries(value)) {
      resolved[key] = resolvePropValue(val, ctx);
    }
    return resolved;
  }
  return value;
}
function resolveElementProps(props, ctx) {
  const resolved = {};
  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolvePropValue(value, ctx);
  }
  return resolved;
}
function resolveBindings(props, ctx) {
  let bindings;
  for (const [key, value] of Object.entries(props)) {
    if (isBindStateExpression(value)) {
      if (!bindings) bindings = {};
      bindings[key] = value.$bindState;
    } else if (isBindItemExpression(value)) {
      const resolved = resolveBindItemPath(value.$bindItem, ctx);
      if (resolved !== void 0) {
        if (!bindings) bindings = {};
        bindings[key] = resolved;
      }
    }
  }
  return bindings;
}
function resolveActionParam(value, ctx) {
  if (isItemExpression(value)) {
    return resolveBindItemPath(value.$item, ctx);
  }
  if (isIndexExpression(value)) {
    return ctx.repeatIndex;
  }
  return resolvePropValue(value, ctx);
}
var ActionConfirmSchema = object({
  title: string(),
  message: string(),
  confirmLabel: string().optional(),
  cancelLabel: string().optional(),
  variant: _enum(["default", "danger"]).optional()
});
var ActionOnSuccessSchema = union([
  object({ navigate: string() }),
  object({ set: record(string(), unknown()) }),
  object({ action: string() })
]);
var ActionOnErrorSchema = union([
  object({ set: record(string(), unknown()) }),
  object({ action: string() })
]);
var ActionBindingSchema = object({
  action: string(),
  params: record(string(), DynamicValueSchema).optional(),
  confirm: ActionConfirmSchema.optional(),
  onSuccess: ActionOnSuccessSchema.optional(),
  onError: ActionOnErrorSchema.optional(),
  preventDefault: boolean().optional()
});
var ActionSchema = ActionBindingSchema;
function resolveAction(binding, stateModel) {
  const resolvedParams = {};
  if (binding.params) {
    for (const [key, value] of Object.entries(binding.params)) {
      resolvedParams[key] = resolveDynamicValue(value, stateModel);
    }
  }
  let confirm = binding.confirm;
  if (confirm) {
    confirm = {
      ...confirm,
      message: interpolateString(confirm.message, stateModel),
      title: interpolateString(confirm.title, stateModel)
    };
  }
  return {
    action: binding.action,
    params: resolvedParams,
    confirm,
    onSuccess: binding.onSuccess,
    onError: binding.onError
  };
}
function interpolateString(template, stateModel) {
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = resolveDynamicValue({ $state: path }, stateModel);
    return String(value ?? "");
  });
}
async function executeAction(ctx) {
  const { action: action2, handler, setState, navigate, executeAction: executeAction2 } = ctx;
  try {
    await handler(action2.params);
    if (action2.onSuccess) {
      if ("navigate" in action2.onSuccess && navigate) {
        navigate(action2.onSuccess.navigate);
      } else if ("set" in action2.onSuccess) {
        for (const [path, value] of Object.entries(action2.onSuccess.set)) {
          setState(path, value);
        }
      } else if ("action" in action2.onSuccess && executeAction2) {
        await executeAction2(action2.onSuccess.action);
      }
    }
  } catch (error) {
    if (action2.onError) {
      if ("set" in action2.onError) {
        for (const [path, value] of Object.entries(action2.onError.set)) {
          const resolvedValue = typeof value === "string" && value === "$error.message" ? error.message : value;
          setState(path, resolvedValue);
        }
      } else if ("action" in action2.onError && executeAction2) {
        await executeAction2(action2.onError.action);
      }
    } else {
      throw error;
    }
  }
}
var actionBinding = {
  /** Create a simple action binding */
  simple: (actionName, params) => ({
    action: actionName,
    params
  }),
  /** Create an action binding with confirmation */
  withConfirm: (actionName, confirm, params) => ({
    action: actionName,
    params,
    confirm
  }),
  /** Create an action binding with success handler */
  withSuccess: (actionName, onSuccess, params) => ({
    action: actionName,
    params,
    onSuccess
  })
};
var action = actionBinding;
var ValidationCheckSchema = object({
  type: string(),
  args: record(string(), DynamicValueSchema).optional(),
  message: string()
});
var ValidationConfigSchema = object({
  checks: array(ValidationCheckSchema).optional(),
  validateOn: _enum(["change", "blur", "submit"]).optional(),
  enabled: VisibilityConditionSchema.optional()
});
var matchesImpl = (value, args) => {
  const other = args?.other;
  return value === other;
};
var builtInValidationFunctions = {
  /**
   * Check if value is not null, undefined, or empty string
   */
  required: (value) => {
    if (value === null || value === void 0) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  },
  /**
   * Check if value is a valid email address
   */
  email: (value) => {
    if (typeof value !== "string") return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  },
  /**
   * Check minimum string length
   */
  minLength: (value, args) => {
    if (typeof value !== "string") return false;
    const min = args?.min;
    if (typeof min !== "number") return false;
    return value.length >= min;
  },
  /**
   * Check maximum string length
   */
  maxLength: (value, args) => {
    if (typeof value !== "string") return false;
    const max = args?.max;
    if (typeof max !== "number") return false;
    return value.length <= max;
  },
  /**
   * Check if string matches a regex pattern
   */
  pattern: (value, args) => {
    if (typeof value !== "string") return false;
    const pattern = args?.pattern;
    if (typeof pattern !== "string") return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  },
  /**
   * Check minimum numeric value
   */
  min: (value, args) => {
    if (typeof value !== "number") return false;
    const min = args?.min;
    if (typeof min !== "number") return false;
    return value >= min;
  },
  /**
   * Check maximum numeric value
   */
  max: (value, args) => {
    if (typeof value !== "number") return false;
    const max = args?.max;
    if (typeof max !== "number") return false;
    return value <= max;
  },
  /**
   * Check if value is a number
   */
  numeric: (value) => {
    if (typeof value === "number") return !isNaN(value);
    if (typeof value === "string") return !isNaN(parseFloat(value));
    return false;
  },
  /**
   * Check if value is a valid URL
   */
  url: (value) => {
    if (typeof value !== "string") return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  /**
   * Check if value matches another field
   */
  matches: matchesImpl,
  /**
   * Alias for matches with a more descriptive name for cross-field equality
   */
  equalTo: matchesImpl,
  /**
   * Check if value is less than another field's value.
   * Supports numbers, strings (useful for ISO date comparison), and
   * cross-type numeric coercion (e.g. string "3" vs number 5).
   */
  lessThan: (value, args) => {
    const other = args?.other;
    if (value == null || other == null || value === "" || other === "")
      return false;
    if (typeof value === "number" && typeof other === "number")
      return value < other;
    if (typeof value === "string" && typeof other === "string")
      return value < other;
    const numVal = Number(value);
    const numOther = Number(other);
    if (!isNaN(numVal) && !isNaN(numOther)) return numVal < numOther;
    return false;
  },
  /**
   * Check if value is greater than another field's value.
   * Supports numbers, strings (useful for ISO date comparison), and
   * cross-type numeric coercion (e.g. string "7" vs number 5).
   */
  greaterThan: (value, args) => {
    const other = args?.other;
    if (value == null || other == null || value === "" || other === "")
      return false;
    if (typeof value === "number" && typeof other === "number")
      return value > other;
    if (typeof value === "string" && typeof other === "string")
      return value > other;
    const numVal = Number(value);
    const numOther = Number(other);
    if (!isNaN(numVal) && !isNaN(numOther)) return numVal > numOther;
    return false;
  },
  /**
   * Required only when a condition is met.
   * Uses JS truthiness: 0, false, "", null, and undefined are all
   * treated as "condition not met" (field not required), matching
   * the visibility system's bare-condition semantics.
   */
  requiredIf: (value, args) => {
    const condition = args?.field;
    if (!condition) return true;
    if (value === null || value === void 0) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }
};
function runValidationCheck(check2, ctx) {
  const { value, stateModel, customFunctions } = ctx;
  const resolvedArgs = {};
  if (check2.args) {
    for (const [key, argValue] of Object.entries(check2.args)) {
      resolvedArgs[key] = resolvePropValue(argValue, { stateModel });
    }
  }
  const validationFn = builtInValidationFunctions[check2.type] ?? customFunctions?.[check2.type];
  if (!validationFn) {
    console.warn(`Unknown validation function: ${check2.type}`);
    return {
      type: check2.type,
      valid: true,
      // Don't fail on unknown functions
      message: check2.message
    };
  }
  const valid = validationFn(value, resolvedArgs);
  return {
    type: check2.type,
    valid,
    message: check2.message
  };
}
function runValidation(config2, ctx) {
  const checks = [];
  const errors = [];
  if (config2.enabled) {
    const enabled = evaluateVisibility(config2.enabled, {
      stateModel: ctx.stateModel
    });
    if (!enabled) {
      return { valid: true, errors: [], checks: [] };
    }
  }
  if (config2.checks) {
    for (const check2 of config2.checks) {
      const result = runValidationCheck(check2, ctx);
      checks.push(result);
      if (!result.valid) {
        errors.push(result.message);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    checks
  };
}
var check = {
  required: (message = "This field is required") => ({
    type: "required",
    message
  }),
  email: (message = "Invalid email address") => ({
    type: "email",
    message
  }),
  minLength: (min, message) => ({
    type: "minLength",
    args: { min },
    message: message ?? `Must be at least ${min} characters`
  }),
  maxLength: (max, message) => ({
    type: "maxLength",
    args: { max },
    message: message ?? `Must be at most ${max} characters`
  }),
  pattern: (pattern, message = "Invalid format") => ({
    type: "pattern",
    args: { pattern },
    message
  }),
  min: (min, message) => ({
    type: "min",
    args: { min },
    message: message ?? `Must be at least ${min}`
  }),
  max: (max, message) => ({
    type: "max",
    args: { max },
    message: message ?? `Must be at most ${max}`
  }),
  url: (message = "Invalid URL") => ({
    type: "url",
    message
  }),
  numeric: (message = "Must be a number") => ({
    type: "numeric",
    message
  }),
  matches: (otherPath, message = "Fields must match") => ({
    type: "matches",
    args: { other: { $state: otherPath } },
    message
  }),
  equalTo: (otherPath, message = "Fields must match") => ({
    type: "equalTo",
    args: { other: { $state: otherPath } },
    message
  }),
  lessThan: (otherPath, message) => ({
    type: "lessThan",
    args: { other: { $state: otherPath } },
    message: message ?? "Must be less than the compared field"
  }),
  greaterThan: (otherPath, message) => ({
    type: "greaterThan",
    args: { other: { $state: otherPath } },
    message: message ?? "Must be greater than the compared field"
  }),
  requiredIf: (fieldPath, message = "This field is required") => ({
    type: "requiredIf",
    args: { field: { $state: fieldPath } },
    message
  })
};
function validateSpec(spec, options = {}) {
  const { checkOrphans = false } = options;
  const issues = [];
  if (!spec.root) {
    issues.push({
      severity: "error",
      message: "Spec has no root element defined.",
      code: "missing_root"
    });
    return { valid: false, issues };
  }
  if (!spec.elements[spec.root]) {
    issues.push({
      severity: "error",
      message: `Root element "${spec.root}" not found in elements map.`,
      code: "root_not_found"
    });
  }
  if (Object.keys(spec.elements).length === 0) {
    issues.push({
      severity: "error",
      message: "Spec has no elements.",
      code: "empty_spec"
    });
    return { valid: false, issues };
  }
  for (const [key, element] of Object.entries(spec.elements)) {
    if (element.children) {
      for (const childKey of element.children) {
        if (!spec.elements[childKey]) {
          issues.push({
            severity: "error",
            message: `Element "${key}" references child "${childKey}" which does not exist in the elements map.`,
            elementKey: key,
            code: "missing_child"
          });
        }
      }
    }
    const props = element.props;
    if (props && "visible" in props && props.visible !== void 0) {
      issues.push({
        severity: "error",
        message: `Element "${key}" has "visible" inside "props". It should be a top-level field on the element (sibling of type/props/children).`,
        elementKey: key,
        code: "visible_in_props"
      });
    }
    if (props && "on" in props && props.on !== void 0) {
      issues.push({
        severity: "error",
        message: `Element "${key}" has "on" inside "props". It should be a top-level field on the element (sibling of type/props/children).`,
        elementKey: key,
        code: "on_in_props"
      });
    }
    if (props && "repeat" in props && props.repeat !== void 0) {
      issues.push({
        severity: "error",
        message: `Element "${key}" has "repeat" inside "props". It should be a top-level field on the element (sibling of type/props/children).`,
        elementKey: key,
        code: "repeat_in_props"
      });
    }
    if (props && "watch" in props && props.watch !== void 0) {
      issues.push({
        severity: "error",
        message: `Element "${key}" has "watch" inside "props". It should be a top-level field on the element (sibling of type/props/children).`,
        elementKey: key,
        code: "watch_in_props"
      });
    }
  }
  if (checkOrphans) {
    const reachable = /* @__PURE__ */ new Set();
    const walk = (key) => {
      if (reachable.has(key)) return;
      reachable.add(key);
      const el = spec.elements[key];
      if (el?.children) {
        for (const childKey of el.children) {
          if (spec.elements[childKey]) {
            walk(childKey);
          }
        }
      }
    };
    if (spec.elements[spec.root]) {
      walk(spec.root);
    }
    for (const key of Object.keys(spec.elements)) {
      if (!reachable.has(key)) {
        issues.push({
          severity: "warning",
          message: `Element "${key}" is not reachable from root "${spec.root}".`,
          elementKey: key,
          code: "orphaned_element"
        });
      }
    }
  }
  const hasErrors = issues.some((i) => i.severity === "error");
  return { valid: !hasErrors, issues };
}
function autoFixSpec(spec) {
  const fixes = [];
  const fixedElements = {};
  for (const [key, element] of Object.entries(spec.elements)) {
    const props = element.props;
    let fixed = element;
    if (props && "visible" in props && props.visible !== void 0) {
      const { visible, ...restProps } = fixed.props;
      fixed = {
        ...fixed,
        props: restProps,
        visible
      };
      fixes.push(`Moved "visible" from props to element level on "${key}".`);
    }
    let currentProps = fixed.props;
    if (currentProps && "on" in currentProps && currentProps.on !== void 0) {
      const { on, ...restProps } = currentProps;
      fixed = {
        ...fixed,
        props: restProps,
        on
      };
      fixes.push(`Moved "on" from props to element level on "${key}".`);
    }
    currentProps = fixed.props;
    if (currentProps && "repeat" in currentProps && currentProps.repeat !== void 0) {
      const { repeat, ...restProps } = currentProps;
      fixed = {
        ...fixed,
        props: restProps,
        repeat
      };
      fixes.push(`Moved "repeat" from props to element level on "${key}".`);
    }
    currentProps = fixed.props;
    if (currentProps && "watch" in currentProps && currentProps.watch !== void 0) {
      const { watch, ...restProps } = currentProps;
      fixed = {
        ...fixed,
        props: restProps,
        watch
      };
      fixes.push(`Moved "watch" from props to element level on "${key}".`);
    }
    fixedElements[key] = fixed;
  }
  return {
    spec: { root: spec.root, elements: fixedElements, state: spec.state },
    fixes
  };
}
function formatSpecIssues(issues) {
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length === 0) return "";
  const lines = ["The generated UI spec has the following errors:"];
  for (const issue2 of errors) {
    lines.push(`- ${issue2.message}`);
  }
  return lines.join("\n");
}
var DEFAULT_MODES = ["patch"];
function normalizeModes(config2) {
  if (!config2?.modes?.length) return DEFAULT_MODES;
  return config2.modes;
}
function jsonPatchInstructions() {
  return [
    "PATCH MODE (RFC 6902 JSON Patch):",
    "Output one JSON object per line. Each line is a patch operation.",
    '- Add: {"op":"add","path":"/elements/new-key","value":{...}}',
    '- Replace: {"op":"replace","path":"/elements/existing-key","value":{...}}',
    '- Remove: {"op":"remove","path":"/elements/old-key"}',
    "Only output patches for what needs to change."
  ].join("\n");
}
function jsonMergeInstructions() {
  return [
    "MERGE MODE (RFC 7396 JSON Merge Patch):",
    "Output a single JSON object on one line with __json_edit set to true.",
    "Include only the keys that changed. Unmentioned keys are preserved.",
    "Set a key to null to delete it.",
    "",
    "Example (update a title and add an element):",
    '{"__json_edit":true,"elements":{"main":{"props":{"title":"New Title"}},"new-el":{"type":"Card","props":{},"children":[]}}}',
    "",
    "Example (delete an element):",
    '{"__json_edit":true,"elements":{"old-widget":null}}'
  ].join("\n");
}
function jsonDiffInstructions() {
  return [
    "DIFF MODE (unified diff):",
    "Output a unified diff inside a ```diff code fence.",
    "The diff applies against the JSON-serialized current spec.",
    "",
    "Example:",
    "```diff",
    "--- a/spec.json",
    "+++ b/spec.json",
    "@@ -3,1 +3,1 @@",
    '-      "title": "Login"',
    '+      "title": "Welcome Back"',
    "```"
  ].join("\n");
}
function yamlPatchInstructions() {
  return [
    "PATCH MODE (RFC 6902 JSON Patch):",
    "Output RFC 6902 JSON Patch lines inside a ```yaml-patch code fence.",
    "Each line is one JSON patch operation.",
    "",
    "Example:",
    "```yaml-patch",
    '{"op":"replace","path":"/elements/main/props/title","value":"New Title"}',
    '{"op":"add","path":"/elements/new-el","value":{"type":"Card","props":{},"children":[]}}',
    "```"
  ].join("\n");
}
function yamlMergeInstructions() {
  return [
    "MERGE MODE (RFC 7396 JSON Merge Patch):",
    "Output only the changed parts in a ```yaml-edit code fence.",
    "Uses deep merge semantics: only keys you include are updated. Unmentioned elements and props are preserved.",
    "Set a key to null to delete it.",
    "",
    "Example edit (update title, add a new element):",
    "```yaml-edit",
    "elements:",
    "  main:",
    "    props:",
    "      title: Updated Title",
    "  new-chart:",
    "    type: Card",
    "    props: {}",
    "    children: []",
    "```",
    "",
    "Example deletion:",
    "```yaml-edit",
    "elements:",
    "  old-widget: null",
    "```"
  ].join("\n");
}
function yamlDiffInstructions() {
  return [
    "DIFF MODE (unified diff):",
    "Output a unified diff inside a ```diff code fence.",
    "The diff applies against the YAML-serialized current spec.",
    "",
    "Example:",
    "```diff",
    "--- a/spec.yaml",
    "+++ b/spec.yaml",
    "@@ -6,1 +6,1 @@",
    "-      title: Login",
    "+      title: Welcome Back",
    "```"
  ].join("\n");
}
function modeSelectionGuidance(modes) {
  if (modes.length === 1) return "";
  const parts = ["Choose the best edit strategy for the requested change:"];
  if (modes.includes("patch")) {
    parts.push("- PATCH: best for precise, targeted single-field updates");
  }
  if (modes.includes("merge")) {
    parts.push(
      "- MERGE: best for structural changes (add/remove elements, reparent children, update multiple props at once)"
    );
  }
  if (modes.includes("diff")) {
    parts.push(
      "- DIFF: best for small text-level changes when you can see the exact lines to change"
    );
  }
  return parts.join("\n");
}
function buildEditInstructions(config2, format) {
  const modes = normalizeModes(config2);
  const sections = [];
  sections.push("EDITING EXISTING SPECS:");
  sections.push("");
  const guidance = modeSelectionGuidance(modes);
  if (guidance) {
    sections.push(guidance);
    sections.push("");
  }
  for (const mode of modes) {
    if (format === "json") {
      switch (mode) {
        case "patch":
          sections.push(jsonPatchInstructions());
          break;
        case "merge":
          sections.push(jsonMergeInstructions());
          break;
        case "diff":
          sections.push(jsonDiffInstructions());
          break;
      }
    } else {
      switch (mode) {
        case "patch":
          sections.push(yamlPatchInstructions());
          break;
        case "merge":
          sections.push(yamlMergeInstructions());
          break;
        case "diff":
          sections.push(yamlDiffInstructions());
          break;
      }
    }
    sections.push("");
  }
  return sections.join("\n");
}
function addLineNumbers(text) {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
}
function isNonEmptySpec(spec) {
  if (!spec || typeof spec !== "object") return false;
  const s = spec;
  return typeof s.root === "string" && typeof s.elements === "object" && s.elements !== null && Object.keys(s.elements).length > 0;
}
function buildEditUserPrompt(options) {
  const { prompt, currentSpec, config: config2, format, maxPromptLength, serializer } = options;
  let userText = String(prompt || "");
  if (maxPromptLength !== void 0 && maxPromptLength > 0) {
    userText = userText.slice(0, maxPromptLength);
  }
  if (!isNonEmptySpec(currentSpec)) {
    return userText;
  }
  const modes = normalizeModes(config2);
  const showLineNumbers = modes.includes("diff");
  const serialize = serializer ?? ((s) => JSON.stringify(s, null, 2));
  const specText = serialize(currentSpec);
  const parts = [];
  if (showLineNumbers) {
    parts.push("CURRENT UI STATE (line numbers for reference):");
    parts.push("```");
    parts.push(addLineNumbers(specText));
    parts.push("```");
  } else {
    parts.push(
      "CURRENT UI STATE (already loaded, DO NOT recreate existing elements):"
    );
    parts.push("```");
    parts.push(specText);
    parts.push("```");
  }
  parts.push("");
  parts.push(`USER REQUEST: ${userText}`);
  parts.push("");
  if (modes.length === 1) {
    const mode = modes[0];
    switch (mode) {
      case "patch":
        parts.push(
          format === "yaml" ? "Output ONLY the patches in a ```yaml-patch fence." : "Output ONLY the JSON Patch lines needed for the change."
        );
        break;
      case "merge":
        parts.push(
          format === "yaml" ? "Output ONLY the changes in a ```yaml-edit fence. Include only keys that need to change." : "Output ONLY a single JSON merge line with __json_edit set to true. Include only keys that need to change."
        );
        break;
      case "diff":
        parts.push("Output ONLY the unified diff in a ```diff fence.");
        break;
    }
  } else {
    const modeNames = modes.map((m) => {
      switch (m) {
        case "patch":
          return format === "yaml" ? "```yaml-patch fence" : "JSON Patch lines";
        case "merge":
          return format === "yaml" ? "```yaml-edit fence" : "JSON merge line (__json_edit)";
        case "diff":
          return "```diff fence";
      }
    });
    parts.push(
      `Choose the best edit strategy and output using one of: ${modeNames.join(", ")}`
    );
  }
  return parts.join("\n");
}
function createBuilder() {
  return {
    string: () => ({ kind: "string" }),
    number: () => ({ kind: "number" }),
    boolean: () => ({ kind: "boolean" }),
    array: (item) => ({ kind: "array", inner: item }),
    object: (shape) => ({ kind: "object", inner: shape }),
    record: (value) => ({ kind: "record", inner: value }),
    any: () => ({ kind: "any" }),
    zod: () => ({ kind: "zod" }),
    ref: (path) => ({ kind: "ref", inner: path }),
    propsOf: (path) => ({ kind: "propsOf", inner: path }),
    map: (entryShape) => ({ kind: "map", inner: entryShape }),
    optional: () => ({ optional: true })
  };
}
function defineSchema(builder, options) {
  const s = createBuilder();
  const definition = builder(s);
  return {
    definition,
    promptTemplate: options?.promptTemplate,
    defaultRules: options?.defaultRules,
    builtInActions: options?.builtInActions,
    createCatalog(catalog) {
      return createCatalogFromSchema(this, catalog);
    }
  };
}
function createCatalogFromSchema(schema, catalogData) {
  const components = catalogData.components;
  const actions = catalogData.actions;
  const componentNames = components ? Object.keys(components) : [];
  const actionNames = actions ? Object.keys(actions) : [];
  const zodSchema = buildZodSchemaFromDefinition(
    schema.definition,
    catalogData
  );
  return {
    schema,
    data: catalogData,
    componentNames,
    actionNames,
    prompt(options = {}) {
      return generatePrompt(this, options);
    },
    jsonSchema(options = {}) {
      return zodToJsonSchema(zodSchema, options.strict ?? false);
    },
    validate(spec) {
      const result = zodSchema.safeParse(spec);
      if (result.success) {
        return {
          success: true,
          data: result.data
        };
      }
      return { success: false, error: result.error };
    },
    zodSchema() {
      return zodSchema;
    },
    get _specType() {
      throw new Error("_specType is only for type inference");
    }
  };
}
function buildZodSchemaFromDefinition(definition, catalogData) {
  return buildZodType(definition.spec, catalogData);
}
function buildZodType(schemaType, catalogData) {
  switch (schemaType.kind) {
    case "string":
      return string();
    case "number":
      return number();
    case "boolean":
      return boolean();
    case "any":
      return any();
    case "array": {
      const inner = buildZodType(schemaType.inner, catalogData);
      return array(inner);
    }
    case "object": {
      const shape = schemaType.inner;
      const zodShape = {};
      for (const [key, value] of Object.entries(shape)) {
        let zodType = buildZodType(value, catalogData);
        if (value.optional) {
          zodType = zodType.optional();
        }
        zodShape[key] = zodType;
      }
      return object(zodShape);
    }
    case "record": {
      const inner = buildZodType(schemaType.inner, catalogData);
      return record(string(), inner);
    }
    case "ref": {
      const path = schemaType.inner;
      const keys = getKeysFromPath(path, catalogData);
      if (keys.length === 0) {
        return string();
      }
      if (keys.length === 1) {
        return literal(keys[0]);
      }
      return _enum(keys);
    }
    case "propsOf": {
      const path = schemaType.inner;
      const propsSchemas = getPropsFromPath(path, catalogData);
      if (propsSchemas.length === 0) {
        return record(string(), unknown());
      }
      if (propsSchemas.length === 1) {
        return propsSchemas[0];
      }
      return record(string(), unknown());
    }
    default:
      return unknown();
  }
}
function getKeysFromPath(path, catalogData) {
  const parts = path.split(".");
  let current = { catalog: catalogData };
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = current[part];
    } else {
      return [];
    }
  }
  if (current && typeof current === "object") {
    return Object.keys(current);
  }
  return [];
}
function getPropsFromPath(path, catalogData) {
  const parts = path.split(".");
  let current = { catalog: catalogData };
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = current[part];
    } else {
      return [];
    }
  }
  if (current && typeof current === "object") {
    return Object.values(current).map((entry) => entry.props).filter((props) => props !== void 0);
  }
  return [];
}
function generatePrompt(catalog, options) {
  if (catalog.schema.promptTemplate) {
    const context = {
      catalog: catalog.data,
      componentNames: catalog.componentNames,
      actionNames: catalog.actionNames,
      options,
      formatZodType
    };
    return catalog.schema.promptTemplate(context);
  }
  const {
    system = "You are a UI generator that outputs JSON.",
    customRules = [],
    mode: rawMode = "standalone"
  } = options;
  const mode = rawMode === "chat" ? (console.warn(
    '[json-render] mode "chat" is deprecated, use "inline" instead'
  ), "inline") : rawMode === "generate" ? (console.warn(
    '[json-render] mode "generate" is deprecated, use "standalone" instead'
  ), "standalone") : rawMode;
  const lines = [];
  lines.push(system);
  lines.push("");
  if (mode === "inline") {
    lines.push("OUTPUT FORMAT (text + JSONL, RFC 6902 JSON Patch):");
    lines.push(
      "You respond conversationally. When generating UI, first write a brief explanation (1-3 sentences), then output JSONL patch lines wrapped in a ```spec code fence."
    );
    lines.push(
      "The JSONL lines use RFC 6902 JSON Patch operations to build a UI tree. Always wrap them in a ```spec fence block:"
    );
    lines.push("  ```spec");
    lines.push('  {"op":"add","path":"/root","value":"main"}');
    lines.push(
      '  {"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Hello"},"children":[]}}'
    );
    lines.push("  ```");
    lines.push(
      "If the user's message does not require a UI (e.g. a greeting or clarifying question), respond with text only — no JSONL."
    );
  } else {
    lines.push("OUTPUT FORMAT (JSONL, RFC 6902 JSON Patch):");
    lines.push(
      "Output JSONL (one JSON object per line) using RFC 6902 JSON Patch operations to build a UI tree."
    );
  }
  lines.push(
    "Each line is a JSON patch operation (add, remove, replace). Start with /root, then stream /elements and /state patches interleaved so the UI fills in progressively as it streams."
  );
  lines.push("");
  lines.push("Example output (each line is a separate JSON object):");
  lines.push("");
  const allComponents = catalog.data.components;
  const cn = catalog.componentNames;
  const comp1 = cn[0] || "Component";
  const comp2 = cn.length > 1 ? cn[1] : comp1;
  const comp1Def = allComponents?.[comp1];
  const comp2Def = allComponents?.[comp2];
  const comp1Props = comp1Def ? getExampleProps(comp1Def) : {};
  const comp2Props = comp2Def ? getExampleProps(comp2Def) : {};
  const dynamicPropName = comp2Def?.props ? findFirstStringProp(comp2Def.props) : null;
  const dynamicProps = dynamicPropName ? { ...comp2Props, [dynamicPropName]: { $item: "title" } } : comp2Props;
  const exampleOutput = [
    JSON.stringify({ op: "add", path: "/root", value: "main" }),
    JSON.stringify({
      op: "add",
      path: "/elements/main",
      value: {
        type: comp1,
        props: comp1Props,
        children: ["child-1", "list"]
      }
    }),
    JSON.stringify({
      op: "add",
      path: "/elements/child-1",
      value: { type: comp2, props: comp2Props, children: [] }
    }),
    JSON.stringify({
      op: "add",
      path: "/elements/list",
      value: {
        type: comp1,
        props: comp1Props,
        repeat: { statePath: "/items", key: "id" },
        children: ["item"]
      }
    }),
    JSON.stringify({
      op: "add",
      path: "/elements/item",
      value: { type: comp2, props: dynamicProps, children: [] }
    }),
    JSON.stringify({ op: "add", path: "/state/items", value: [] }),
    JSON.stringify({
      op: "add",
      path: "/state/items/0",
      value: { id: "1", title: "First Item" }
    }),
    JSON.stringify({
      op: "add",
      path: "/state/items/1",
      value: { id: "2", title: "Second Item" }
    })
  ].join("\n");
  lines.push(`${exampleOutput}

Note: state patches appear right after the elements that use them, so the UI fills in as it streams. ONLY use component types from the AVAILABLE COMPONENTS list below.`);
  lines.push("");
  lines.push("INITIAL STATE:");
  lines.push(
    "Specs include a /state field to seed the state model. Components with { $bindState } or { $bindItem } read from and write to this state, and $state expressions read from it."
  );
  lines.push(
    "CRITICAL: You MUST include state patches whenever your UI displays data via $state, $bindState, $bindItem, $item, or $index expressions, or uses repeat to iterate over arrays. Without state, these references resolve to nothing and repeat lists render zero items."
  );
  lines.push(
    "Output state patches right after the elements that reference them, so the UI fills in progressively as it streams."
  );
  lines.push(
    "Stream state progressively - output one patch per array item instead of one giant blob:"
  );
  lines.push(
    '  For arrays: {"op":"add","path":"/state/posts/0","value":{"id":"1","title":"First Post",...}} then /state/posts/1, /state/posts/2, etc.'
  );
  lines.push(
    '  For scalars: {"op":"add","path":"/state/newTodoText","value":""}'
  );
  lines.push(
    '  Initialize the array first if needed: {"op":"add","path":"/state/posts","value":[]}'
  );
  lines.push(
    'When content comes from the state model, use { "$state": "/some/path" } dynamic props to display it instead of hardcoding the same value in both state and props. The state model is the single source of truth.'
  );
  lines.push(
    "Include realistic sample data in state. For blogs: 3-4 posts with titles, excerpts, authors, dates. For product lists: 3-5 items with names, prices, descriptions. Never leave arrays empty."
  );
  lines.push("");
  lines.push("DYNAMIC LISTS (repeat field):");
  lines.push(
    'Any element can have a top-level "repeat" field to render its children once per item in a state array: { "repeat": { "statePath": "/arrayPath", "key": "id" } }.'
  );
  lines.push(
    'The element itself renders once (as the container), and its children are expanded once per array item. "statePath" is the state array path. "key" is an optional field name on each item for stable React keys.'
  );
  lines.push(
    `Example: ${JSON.stringify({ type: comp1, props: comp1Props, repeat: { statePath: "/todos", key: "id" }, children: ["todo-item"] })}`
  );
  lines.push(
    'Inside children of a repeated element, use { "$item": "field" } to read a field from the current item, and { "$index": true } to get the current array index. For two-way binding to an item field use { "$bindItem": "completed" } on the appropriate prop.'
  );
  lines.push(
    "ALWAYS use the repeat field for lists backed by state arrays. NEVER hardcode individual elements for each array item."
  );
  lines.push(
    'IMPORTANT: "repeat" is a top-level field on the element (sibling of type/props/children), NOT inside props.'
  );
  lines.push("");
  lines.push("ARRAY STATE ACTIONS:");
  lines.push(
    'Use action "pushState" to append items to arrays. Params: { statePath: "/arrayPath", value: { ...item }, clearStatePath: "/inputPath" }.'
  );
  lines.push(
    'Values inside pushState can contain { "$state": "/statePath" } references to read current state (e.g. the text from an input field).'
  );
  lines.push(
    'Use "$id" inside a pushState value to auto-generate a unique ID.'
  );
  lines.push(
    'Example: on: { "press": { "action": "pushState", "params": { "statePath": "/todos", "value": { "id": "$id", "title": { "$state": "/newTodoText" }, "completed": false }, "clearStatePath": "/newTodoText" } } }'
  );
  lines.push(
    `Use action "removeState" to remove items from arrays by index. Params: { statePath: "/arrayPath", index: N }. Inside a repeated element's children, use { "$index": true } for the current item index. Action params support the same expressions as props: { "$item": "field" } resolves to the absolute state path, { "$index": true } resolves to the index number, and { "$state": "/path" } reads a value from state.`
  );
  lines.push(
    "For lists where users can add/remove items (todos, carts, etc.), use pushState and removeState instead of hardcoding with setState."
  );
  lines.push("");
  lines.push(
    'IMPORTANT: State paths use RFC 6901 JSON Pointer syntax (e.g. "/todos/0/title"). Do NOT use JavaScript-style dot notation (e.g. "/todos.length" is WRONG). To generate unique IDs for new items, use "$id" instead of trying to read array length.'
  );
  lines.push("");
  const components = allComponents;
  if (components) {
    lines.push(`AVAILABLE COMPONENTS (${catalog.componentNames.length}):`);
    lines.push("");
    for (const [name, def] of Object.entries(components)) {
      const propsStr = def.props ? formatZodType(def.props) : "{}";
      const hasChildren = def.slots && def.slots.length > 0;
      const childrenStr = hasChildren ? " [accepts children]" : "";
      const eventsStr = def.events && def.events.length > 0 ? ` [events: ${def.events.join(", ")}]` : "";
      const descStr = def.description ? ` - ${def.description}` : "";
      lines.push(`- ${name}: ${propsStr}${descStr}${childrenStr}${eventsStr}`);
    }
    lines.push("");
  }
  const actions = catalog.data.actions;
  const builtInActions = catalog.schema.builtInActions ?? [];
  const hasCustomActions = actions && catalog.actionNames.length > 0;
  const hasBuiltInActions = builtInActions.length > 0;
  if (hasCustomActions || hasBuiltInActions) {
    lines.push("AVAILABLE ACTIONS:");
    lines.push("");
    for (const action2 of builtInActions) {
      lines.push(`- ${action2.name}: ${action2.description} [built-in]`);
    }
    if (hasCustomActions) {
      for (const [name, def] of Object.entries(actions)) {
        lines.push(`- ${name}${def.description ? `: ${def.description}` : ""}`);
      }
    }
    lines.push("");
  }
  lines.push("EVENTS (the `on` field):");
  lines.push(
    "Elements can have an optional `on` field to bind events to actions. The `on` field is a top-level field on the element (sibling of type/props/children), NOT inside props."
  );
  lines.push(
    'Each key in `on` is an event name (from the component\'s supported events), and the value is an action binding: `{ "action": "<actionName>", "params": { ... } }`.'
  );
  lines.push("");
  lines.push("Example:");
  lines.push(
    `  ${JSON.stringify({ type: comp1, props: comp1Props, on: { press: { action: "setState", params: { statePath: "/saved", value: true } } }, children: [] })}`
  );
  lines.push("");
  lines.push(
    'Action params can use dynamic references to read from state: { "$state": "/statePath" }.'
  );
  lines.push(
    "IMPORTANT: Do NOT put action/actionParams inside props. Always use the `on` field for event bindings."
  );
  lines.push("");
  lines.push("VISIBILITY CONDITIONS:");
  lines.push(
    "Elements can have an optional `visible` field to conditionally show/hide based on state. IMPORTANT: `visible` is a top-level field on the element object (sibling of type/props/children), NOT inside props."
  );
  lines.push(
    `Correct: ${JSON.stringify({ type: comp1, props: comp1Props, visible: { $state: "/activeTab", eq: "home" }, children: ["..."] })}`
  );
  lines.push(
    '- `{ "$state": "/path" }` - visible when state at path is truthy'
  );
  lines.push(
    '- `{ "$state": "/path", "not": true }` - visible when state at path is falsy'
  );
  lines.push(
    '- `{ "$state": "/path", "eq": "value" }` - visible when state equals value'
  );
  lines.push(
    '- `{ "$state": "/path", "neq": "value" }` - visible when state does not equal value'
  );
  lines.push(
    '- `{ "$state": "/path", "gt": N }` / `gte` / `lt` / `lte` - numeric comparisons'
  );
  lines.push(
    "- Use ONE operator per condition (eq, neq, gt, gte, lt, lte). Do not combine multiple operators."
  );
  lines.push('- Any condition can add `"not": true` to invert its result');
  lines.push(
    "- `[condition, condition]` - all conditions must be true (implicit AND)"
  );
  lines.push(
    '- `{ "$and": [condition, condition] }` - explicit AND (use when nesting inside $or)'
  );
  lines.push(
    '- `{ "$or": [condition, condition] }` - at least one must be true (OR)'
  );
  lines.push("- `true` / `false` - always visible/hidden");
  lines.push("");
  lines.push(
    "Use a component with on.press bound to setState to update state and drive visibility."
  );
  lines.push(
    `Example: A ${comp1} with on: { "press": { "action": "setState", "params": { "statePath": "/activeTab", "value": "home" } } } sets state, then a container with visible: { "$state": "/activeTab", "eq": "home" } shows only when that tab is active.`
  );
  lines.push("");
  lines.push(
    'For tab patterns where the first/default tab should be visible when no tab is selected yet, use $or to handle both cases: visible: { "$or": [{ "$state": "/activeTab", "eq": "home" }, { "$state": "/activeTab", "not": true }] }. This ensures the first tab is visible both when explicitly selected AND when /activeTab is not yet set.'
  );
  lines.push("");
  lines.push("DYNAMIC PROPS:");
  lines.push(
    "Any prop value can be a dynamic expression that resolves based on state. Three forms are supported:"
  );
  lines.push("");
  lines.push(
    '1. Read-only state: `{ "$state": "/statePath" }` - resolves to the value at that state path (one-way read).'
  );
  lines.push(
    '   Example: `"color": { "$state": "/theme/primary" }` reads the color from state.'
  );
  lines.push("");
  lines.push(
    '2. Two-way binding: `{ "$bindState": "/statePath" }` - resolves to the value at the state path AND enables write-back. Use on form input props (value, checked, pressed, etc.).'
  );
  lines.push(
    '   Example: `"value": { "$bindState": "/form/email" }` binds the input value to /form/email.'
  );
  lines.push(
    '   Inside repeat scopes: `"checked": { "$bindItem": "completed" }` binds to the current item\'s completed field.'
  );
  lines.push("");
  lines.push(
    '3. Conditional: `{ "$cond": <condition>, "$then": <value>, "$else": <value> }` - evaluates the condition (same syntax as visibility conditions) and picks the matching value.'
  );
  lines.push(
    '   Example: `"color": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "#007AFF", "$else": "#8E8E93" }`'
  );
  lines.push("");
  lines.push(
    "Use $bindState for form inputs (text fields, checkboxes, selects, sliders, etc.) and $state for read-only data display. Inside repeat scopes, use $bindItem for form inputs bound to the current item. Use dynamic props instead of duplicating elements with opposing visible conditions when only prop values differ."
  );
  lines.push("");
  lines.push(
    '4. Template: `{ "$template": "Hello, ${/name}!" }` - interpolates `${/path}` references in the string with values from the state model.'
  );
  lines.push(
    '   Example: `"label": { "$template": "Items: ${/cart/count} | Total: ${/cart/total}" }` renders "Items: 3 | Total: 42.00" when /cart/count is 3 and /cart/total is 42.00.'
  );
  lines.push("");
  const catalogFunctions = catalog.data.functions;
  if (catalogFunctions && Object.keys(catalogFunctions).length > 0) {
    lines.push(
      '5. Computed: `{ "$computed": "<functionName>", "args": { "key": <expression> } }` - calls a registered function with resolved args and returns the result.'
    );
    lines.push(
      '   Example: `"value": { "$computed": "fullName", "args": { "first": { "$state": "/form/firstName" }, "last": { "$state": "/form/lastName" } } }`'
    );
    lines.push("   Available functions:");
    for (const name of Object.keys(
      catalogFunctions
    )) {
      lines.push(`   - ${name}`);
    }
    lines.push("");
  }
  const hasChecksComponents = allComponents ? Object.entries(allComponents).some(([, def]) => {
    if (!def.props) return false;
    const formatted = formatZodType(def.props);
    return formatted.includes("checks");
  }) : false;
  if (hasChecksComponents) {
    lines.push("VALIDATION:");
    lines.push(
      "Form components that accept a `checks` prop support client-side validation."
    );
    lines.push(
      'Each check is an object: { "type": "<name>", "message": "...", "args": { ... } }'
    );
    lines.push("");
    lines.push("Built-in validation types:");
    lines.push("  - required — value must be non-empty");
    lines.push("  - email — valid email format");
    lines.push('  - minLength — minimum string length (args: { "min": N })');
    lines.push('  - maxLength — maximum string length (args: { "max": N })');
    lines.push('  - pattern — match a regex (args: { "pattern": "regex" })');
    lines.push('  - min — minimum numeric value (args: { "min": N })');
    lines.push('  - max — maximum numeric value (args: { "max": N })');
    lines.push("  - numeric — value must be a number");
    lines.push("  - url — valid URL format");
    lines.push(
      '  - matches — must equal another field (args: { "other": { "$state": "/path" } })'
    );
    lines.push(
      '  - equalTo — alias for matches (args: { "other": { "$state": "/path" } })'
    );
    lines.push(
      '  - lessThan — value must be less than another field (args: { "other": { "$state": "/path" } })'
    );
    lines.push(
      '  - greaterThan — value must be greater than another field (args: { "other": { "$state": "/path" } })'
    );
    lines.push(
      '  - requiredIf — required only when another field is truthy (args: { "field": { "$state": "/path" } })'
    );
    lines.push("");
    lines.push("Example:");
    lines.push(
      '  "checks": [{ "type": "required", "message": "Email is required" }, { "type": "email", "message": "Invalid email" }]'
    );
    lines.push("");
    lines.push(
      "IMPORTANT: When using checks, the component must also have a { $bindState } or { $bindItem } on its value/checked prop for two-way binding."
    );
    lines.push(
      "Always include validation checks on form inputs for a good user experience (e.g. required, email, minLength)."
    );
    lines.push("");
  }
  if (hasCustomActions || hasBuiltInActions) {
    lines.push("STATE WATCHERS:");
    lines.push(
      "Elements can have an optional `watch` field to react to state changes and trigger actions. The `watch` field is a top-level field on the element (sibling of type/props/children), NOT inside props."
    );
    lines.push(
      "Maps state paths (JSON Pointers) to action bindings. When the value at a watched path changes, the bound actions fire automatically."
    );
    lines.push("");
    lines.push(
      "Example (cascading select — country changes trigger city loading):"
    );
    lines.push(
      `  ${JSON.stringify({ type: "Select", props: { value: { $bindState: "/form/country" }, options: ["US", "Canada", "UK"] }, watch: { "/form/country": { action: "loadCities", params: { country: { $state: "/form/country" } } } }, children: [] })}`
    );
    lines.push("");
    lines.push(
      "Use `watch` for cascading dependencies where changing one field should trigger side effects (loading data, resetting dependent fields, computing derived values)."
    );
    lines.push(
      "IMPORTANT: `watch` is a top-level field on the element (sibling of type/props/children), NOT inside props. Watchers only fire when the value changes, not on initial render."
    );
    lines.push("");
  }
  const editModes = options.editModes;
  if (editModes && editModes.length > 0) {
    lines.push(buildEditInstructions({ modes: editModes }, "json"));
  }
  lines.push("RULES:");
  const baseRules = mode === "inline" ? [
    "When generating UI, wrap all JSONL patches in a ```spec code fence - one JSON object per line inside the fence",
    "Write a brief conversational response before any JSONL output",
    'First set root: {"op":"add","path":"/root","value":"<root-key>"}',
    'Then add each element: {"op":"add","path":"/elements/<key>","value":{...}}',
    "Output /state patches right after the elements that use them, one per array item for progressive loading. REQUIRED whenever using $state, $bindState, $bindItem, $item, $index, or repeat.",
    "ONLY use components listed above",
    "Each element value needs: type, props, children (array of child keys)",
    "Use unique keys for the element map entries (e.g., 'header', 'metric-1', 'chart-revenue')"
  ] : [
    "Output ONLY JSONL patches - one JSON object per line, no markdown, no code fences",
    'First set root: {"op":"add","path":"/root","value":"<root-key>"}',
    'Then add each element: {"op":"add","path":"/elements/<key>","value":{...}}',
    "Output /state patches right after the elements that use them, one per array item for progressive loading. REQUIRED whenever using $state, $bindState, $bindItem, $item, $index, or repeat.",
    "ONLY use components listed above",
    "Each element value needs: type, props, children (array of child keys)",
    "Use unique keys for the element map entries (e.g., 'header', 'metric-1', 'chart-revenue')"
  ];
  const schemaRules = catalog.schema.defaultRules ?? [];
  const allRules = [...baseRules, ...schemaRules, ...customRules];
  allRules.forEach((rule, i) => {
    lines.push(`${i + 1}. ${rule}`);
  });
  return lines.join("\n");
}
function getExampleProps(def) {
  if (def.example && Object.keys(def.example).length > 0) {
    return def.example;
  }
  if (def.props) {
    return generateExamplePropsFromZod(def.props);
  }
  return {};
}
function generateExamplePropsFromZod(schema) {
  if (!schema || !schema._def) return {};
  const def = schema._def;
  const typeName = getZodTypeName(schema);
  if (typeName !== "ZodObject" && typeName !== "object") return {};
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (!shape) return {};
  const result = {};
  for (const [key, value] of Object.entries(shape)) {
    const innerTypeName = getZodTypeName(value);
    if (innerTypeName === "ZodOptional" || innerTypeName === "optional" || innerTypeName === "ZodNullable" || innerTypeName === "nullable") {
      continue;
    }
    result[key] = generateExampleValue(value);
  }
  return result;
}
function generateExampleValue(schema) {
  if (!schema || !schema._def) return "...";
  const def = schema._def;
  const typeName = getZodTypeName(schema);
  switch (typeName) {
    case "ZodString":
    case "string":
      return "example";
    case "ZodNumber":
    case "number":
      return 0;
    case "ZodBoolean":
    case "boolean":
      return true;
    case "ZodLiteral":
    case "literal":
      return def.value;
    case "ZodEnum":
    case "enum": {
      if (Array.isArray(def.values) && def.values.length > 0)
        return def.values[0];
      if (def.entries && typeof def.entries === "object") {
        const values = Object.values(def.entries);
        return values.length > 0 ? values[0] : "example";
      }
      return "example";
    }
    case "ZodOptional":
    case "optional":
    case "ZodNullable":
    case "nullable":
    case "ZodDefault":
    case "default": {
      const inner = def.innerType ?? def.wrapped;
      return inner ? generateExampleValue(inner) : null;
    }
    case "ZodArray":
    case "array":
      return [];
    case "ZodObject":
    case "object":
      return generateExamplePropsFromZod(schema);
    case "ZodUnion":
    case "union": {
      const options = def.options;
      return options && options.length > 0 ? generateExampleValue(options[0]) : "...";
    }
    default:
      return "...";
  }
}
function findFirstStringProp(schema) {
  if (!schema || !schema._def) return null;
  const def = schema._def;
  const typeName = getZodTypeName(schema);
  if (typeName !== "ZodObject" && typeName !== "object") return null;
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (!shape) return null;
  for (const [key, value] of Object.entries(shape)) {
    const innerTypeName = getZodTypeName(value);
    if (innerTypeName === "ZodOptional" || innerTypeName === "optional" || innerTypeName === "ZodNullable" || innerTypeName === "nullable") {
      continue;
    }
    if (innerTypeName === "ZodString" || innerTypeName === "string") {
      return key;
    }
  }
  return null;
}
function getZodTypeName(schema) {
  if (!schema || !schema._def) return "";
  const def = schema._def;
  return def.typeName ?? def.type ?? "";
}
function formatZodType(schema) {
  if (!schema || !schema._def) return "unknown";
  const def = schema._def;
  const typeName = getZodTypeName(schema);
  switch (typeName) {
    case "ZodString":
    case "string":
      return "string";
    case "ZodNumber":
    case "number":
      return "number";
    case "ZodBoolean":
    case "boolean":
      return "boolean";
    case "ZodLiteral":
    case "literal":
      return JSON.stringify(def.value);
    case "ZodEnum":
    case "enum": {
      let values;
      if (Array.isArray(def.values)) {
        values = def.values;
      } else if (def.entries && typeof def.entries === "object") {
        values = Object.values(def.entries);
      } else {
        return "enum";
      }
      return values.map((v) => `"${v}"`).join(" | ");
    }
    case "ZodArray":
    case "array": {
      const inner = typeof def.element === "object" ? def.element : typeof def.type === "object" ? def.type : void 0;
      return inner ? `Array<${formatZodType(inner)}>` : "Array<unknown>";
    }
    case "ZodObject":
    case "object": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      if (!shape) return "object";
      const props = Object.entries(shape).map(([key, value]) => {
        const innerTypeName = getZodTypeName(value);
        const isOptional = innerTypeName === "ZodOptional" || innerTypeName === "ZodNullable" || innerTypeName === "optional" || innerTypeName === "nullable";
        return `${key}${isOptional ? "?" : ""}: ${formatZodType(value)}`;
      }).join(", ");
      return `{ ${props} }`;
    }
    case "ZodOptional":
    case "optional":
    case "ZodNullable":
    case "nullable": {
      const inner = def.innerType ?? def.wrapped;
      return inner ? formatZodType(inner) : "unknown";
    }
    case "ZodUnion":
    case "union": {
      const options = def.options;
      return options ? options.map((opt) => formatZodType(opt)).join(" | ") : "unknown";
    }
    default:
      return "unknown";
  }
}
function zodTypeName(def) {
  if (typeof def.type === "string") return def.type;
  if (typeof def.typeName === "string") return def.typeName;
  return "";
}
function normalizeTypeName(raw) {
  if (raw.startsWith("Zod")) {
    return raw.slice(3).toLowerCase();
  }
  return raw.toLowerCase();
}
function zodToJsonSchema(schema, strict = false) {
  const def = schema._def;
  const kind = normalizeTypeName(zodTypeName(def));
  switch (kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "literal": {
      const values = def.values;
      const value = values ? values[0] : def.value;
      return { const: value };
    }
    case "enum": {
      const entries = def.entries;
      const values = entries ? Object.values(entries) : def.values;
      return { enum: values ?? [] };
    }
    case "array": {
      const inner = def.element ?? def.type;
      return {
        type: "array",
        items: inner ? zodToJsonSchema(inner, strict) : {}
      };
    }
    case "object": {
      const rawShape = def.shape;
      const shape = typeof rawShape === "function" ? rawShape() : rawShape;
      if (!shape) {
        if (strict) {
          return {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false
          };
        }
        return { type: "object" };
      }
      const properties = {};
      const required2 = [];
      for (const [key, value] of Object.entries(shape)) {
        const innerDef = value._def;
        const innerKind = normalizeTypeName(zodTypeName(innerDef));
        const isOptional = innerKind === "optional" || innerKind === "nullable";
        if (strict) {
          required2.push(key);
          if (isOptional) {
            const unwrapped = zodToJsonSchema(value, strict);
            properties[key] = { anyOf: [unwrapped, { type: "null" }] };
          } else {
            properties[key] = zodToJsonSchema(value, strict);
          }
        } else {
          properties[key] = zodToJsonSchema(value);
          if (!isOptional) {
            required2.push(key);
          }
        }
      }
      return {
        type: "object",
        properties,
        required: required2.length > 0 ? required2 : void 0,
        additionalProperties: false
      };
    }
    case "record": {
      const valueType = def.valueType;
      if (strict) {
        return {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        };
      }
      return {
        type: "object",
        additionalProperties: valueType ? zodToJsonSchema(valueType) : true
      };
    }
    case "optional":
    case "nullable": {
      const inner = def.innerType;
      return inner ? zodToJsonSchema(inner, strict) : {};
    }
    case "union": {
      const options = def.options;
      return options ? { anyOf: options.map((o) => zodToJsonSchema(o, strict)) } : {};
    }
    case "any":
    case "unknown":
      if (strict) {
        return {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        };
      }
      return {};
    default:
      return {};
  }
}
function defineCatalog(schema, catalog) {
  return schema.createCatalog(catalog);
}
function buildUserPrompt(options) {
  const {
    prompt,
    currentSpec,
    state,
    maxPromptLength,
    editModes,
    format,
    serializer
  } = options;
  let userText = String(prompt || "");
  if (maxPromptLength !== void 0 && maxPromptLength > 0) {
    userText = userText.slice(0, maxPromptLength);
  }
  if (isNonEmptySpec(currentSpec)) {
    const editPrompt = buildEditUserPrompt({
      prompt: userText,
      currentSpec,
      config: { modes: editModes ?? ["patch"] },
      format: format ?? "json",
      serializer
    });
    if (state && Object.keys(state).length > 0) {
      return `${editPrompt}

AVAILABLE STATE:
${JSON.stringify(state, null, 2)}`;
    }
    return editPrompt;
  }
  const parts = [userText];
  if (state && Object.keys(state).length > 0) {
    parts.push(`
AVAILABLE STATE:
${JSON.stringify(state, null, 2)}`);
  }
  if (format === "yaml") {
    parts.push(
      `
Output the full spec in a \`\`\`yaml-spec fence. Stream progressively — output elements one at a time.`
    );
  } else {
    parts.push(
      `
Remember: Output /root first, then interleave /elements and /state patches so the UI fills in progressively as it streams. Output each state patch right after the elements that use it, one per array item.`
    );
  }
  return parts.join("\n");
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function deepMergeSpec(base, patch) {
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    if (patchVal === null) {
      delete result[key];
      continue;
    }
    const baseVal = result[key];
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {
      result[key] = deepMergeSpec(baseVal, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result;
}
function escapeToken(token) {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
function buildPath(basePath, key) {
  return `${basePath}/${escapeToken(key)}`;
}
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function diffToPatches(oldObj, newObj, basePath = "") {
  const patches = [];
  for (const key of Object.keys(newObj)) {
    const path = buildPath(basePath, key);
    const oldVal = oldObj[key];
    const newVal = newObj[key];
    if (!(key in oldObj)) {
      patches.push({ op: "add", path, value: newVal });
      continue;
    }
    if (isPlainObject2(oldVal) && isPlainObject2(newVal)) {
      patches.push(...diffToPatches(oldVal, newVal, path));
    } else if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      if (!arraysEqual(oldVal, newVal)) {
        patches.push({ op: "replace", path, value: newVal });
      }
    } else if (oldVal !== newVal) {
      patches.push({ op: "replace", path, value: newVal });
    }
  }
  for (const key of Object.keys(oldObj)) {
    if (!(key in newObj)) {
      patches.push({ op: "remove", path: buildPath(basePath, key) });
    }
  }
  return patches;
}
const index = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ActionBindingSchema,
  ActionConfirmSchema,
  ActionOnErrorSchema,
  ActionOnSuccessSchema,
  ActionSchema,
  DynamicBooleanSchema,
  DynamicNumberSchema,
  DynamicStringSchema,
  DynamicValueSchema,
  SPEC_DATA_PART,
  SPEC_DATA_PART_TYPE,
  ValidationCheckSchema,
  ValidationConfigSchema,
  VisibilityConditionSchema,
  action,
  actionBinding,
  addByPath,
  applySpecPatch,
  applySpecStreamPatch,
  autoFixSpec,
  buildEditInstructions,
  buildEditUserPrompt,
  buildUserPrompt,
  builtInValidationFunctions,
  check,
  compileSpecStream,
  createJsonRenderTransform,
  createMixedStreamParser,
  createSpecStreamCompiler,
  createStateStore,
  deepMergeSpec,
  defineCatalog,
  defineSchema,
  diffToPatches,
  evaluateVisibility,
  executeAction,
  findFormValue,
  formatSpecIssues,
  getByPath,
  interpolateString,
  isNonEmptySpec,
  nestedToFlat,
  parseSpecStreamLine,
  pipeJsonRender,
  removeByPath,
  resolveAction,
  resolveActionParam,
  resolveBindings,
  resolveDynamicValue,
  resolveElementProps,
  resolvePropValue,
  runValidation,
  runValidationCheck,
  setByPath,
  validateSpec,
  visibility
}, Symbol.toStringTag, { value: "Module" }));
export {
  SPEC_DATA_PART_TYPE as S,
  applySpecPatch as a,
  evaluateVisibility as b,
  createStateStore as c,
  defineSchema as d,
  executeAction as e,
  flattenToPointers as f,
  getByPath as g,
  resolveActionParam as h,
  resolveBindings as i,
  resolveElementProps as j,
  runValidation as k,
  createMixedStreamParser as l,
  removeByPath as m,
  nestedToFlat as n,
  index as o,
  resolveAction as r,
  setByPath as s
};
