// Runs in every test child before any project import. The OS sandbox protects
// the host; these immutable evaluator dependencies protect assertion integrity.
import assert from "node:assert";
import strict from "node:assert/strict";
import test from "node:test";
import buffer from "node:buffer";
import Module, { builtinModules, syncBuiltinESMExports } from "node:module";

const seen = new WeakSet();
function freezeGraph(value) {
  if (value === null || typeof value !== "object" && typeof value !== "function" || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, "value")) freezeGraph(descriptor.value);
  }
  Object.freeze(value);
}

// test.assert.register mutates the internal assertion registry even if its
// exported object is frozen. No project module may replace evaluator assertions.
Object.defineProperty(test.assert, "register", {
  value() { throw new Error("PM_TEST_ASSERTION_REGISTRY_LOCKED"); },
  writable: false, configurable: false,
});
freezeGraph(assert);
freezeGraph(strict);
freezeGraph(test.assert);
freezeGraph(test);
freezeGraph(buffer.Buffer);
Object.freeze(buffer);

// Protect the load path as well as the resulting builtin objects. Otherwise a
// CJS _load replacement, require.cache entry or synchronous loader hook could
// return fake assertions to trusted code imported later in the same child.
for (const name of ["register", "registerHooks"]) {
  Object.defineProperty(Module, name, {
    value() { throw new Error("PM_TEST_MODULE_HOOKS_LOCKED"); },
    writable: false, configurable: false,
  });
}
for (const name of builtinModules) {
  const plain = name.replace(/^node:/, "");
  for (const key of [plain, `node:${plain}`]) {
    Object.defineProperty(Module._cache, key, {
      get() { return undefined; },
      set() { throw new Error("PM_TEST_BUILTIN_CACHE_LOCKED"); },
      configurable: false, enumerable: false,
    });
  }
}
Object.freeze(Module._extensions);
Object.freeze(Module.prototype);
Object.freeze(Module);
Object.defineProperty(process, "getBuiltinModule", {
  value: process.getBuiltinModule, writable: false, configurable: false,
});
syncBuiltinESMExports();

// --frozen-intrinsics freezes the language objects and prototypes after this
// preload. Preserve the corresponding global references as well.
for (const name of ["Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt",
  "Date", "RegExp", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "JSON", "Math", "Reflect", "Proxy",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Int8Array", "Uint8ClampedArray",
  "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "Atomics", "Buffer"]) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && Object.hasOwn(descriptor, "value")) {
    Object.defineProperty(globalThis, name, { ...descriptor, writable: false, configurable: false });
  }
}
