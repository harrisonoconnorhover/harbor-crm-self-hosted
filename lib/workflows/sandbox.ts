import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import type { CodeResult } from "./model";

// No host functions, I/O, bindings, secrets, or module loader enter the guest VM.
export function evaluateCode(
  module: QuickJSWASMModule,
  code: string,
  event: unknown,
  {deterministic=false}:{deterministic?:boolean}={},
): CodeResult {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  let ticks = 0;
  runtime.setInterruptHandler(() => ++ticks > 200);
  const vm = runtime.newContext();
  try {
    const result = vm.evalCode(
      `(() => {
      ${deterministic?`
      for (const name of ["Date", "performance", "Atomics", "SharedArrayBuffer"]) {
        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      }
      Object.defineProperty(Math, "random", { value: undefined, writable: false, configurable: false });
      `:''}
      const stringify = JSON.stringify;
      const logs = [];
      const console = Object.freeze({ log: (...values) => {
        if (logs.length < 20) logs.push(values.map(v => typeof v === "string" ? v : stringify(v)).join(" ").slice(0, 500));
      }});
      // Compile user code as a function body, never as part of this wrapper.
      const action = new Function("event", "console", ${JSON.stringify('"use strict";\n' + code)});
      const outputFields = action(${JSON.stringify(event)}, console);
      if (!outputFields || typeof outputFields !== "object" || Array.isArray(outputFields) || typeof outputFields.then === "function") throw new Error("Return an object of named outputs. Async functions are not supported.");
      const text = stringify({ outputFields, logs });
      if (text.length > 32000) throw new Error("Code output exceeds 32,000 characters.");
      return text;
    })()`,
      "custom-action.js",
    );
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new Error(
        error?.message === "interrupted"
          ? "Code exceeded its execution limit."
          : String(error?.message || "Custom code failed.").slice(0, 2000),
      );
    }
    try {
      if (vm.typeof(result.value) !== "string")
        throw new Error("Custom code must return named outputs.");
      const text = vm.getString(result.value);
      if (text.length > 32000)
        throw new Error("Code output exceeds 32,000 characters.");
      const value = JSON.parse(text);
      if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        !value.outputFields ||
        typeof value.outputFields !== "object" ||
        Array.isArray(value.outputFields)
      )
        throw new Error("Invalid code outputs.");
      if (
        !Array.isArray(value.logs) || value.logs.length > 20 ||
        value.logs.some((line: unknown) => typeof line !== "string" || line.length > 500)
      )
        throw new Error("Invalid code logs.");
      return { outputFields: value.outputFields, logs: value.logs };
    } finally {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
