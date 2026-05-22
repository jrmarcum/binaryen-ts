/**
 * @module binaryen-ts/passes
 *
 * Optimization pass registry and runner.
 *
 * Import this module to get access to all built-in passes and the
 * {@link PassRunner} that applies them to a {@link WasmModule}.
 *
 * Importing this module has the side effect of registering all built-in passes
 * with the pass registry. Custom passes can be added via {@link registerPass}.
 *
 * @example
 * ```ts
 * import { PassRunner, listPasses } from "@jrmarcum/binaryen-ts/passes";
 *
 * console.log(listPasses()); // ["DCE", ...]
 *
 * const runner = new PassRunner(module, { optimizeLevel: 2, shrinkLevel: 1 });
 * runner.addDefaultOptimizationPasses().run();
 * ```
 *
 * @license MIT OR Apache-2.0
 */

export {
  createPass,
  defaultPassOptions,
  listPasses,
  PassRunner,
  registerPass,
  shrinkPassOptions,
} from "./pass.ts";
export type { Pass, PassOptions } from "./pass.ts";

// Side-effect imports: register all built-in passes.
import "./dce.ts";
