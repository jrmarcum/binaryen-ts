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
 * console.log(listPasses()); // ["CoalesceLocals", "DCE", "LocalCSE", ...]
 *
 * const runner = new PassRunner(module, { optimizeLevel: 2, shrinkLevel: 1 });
 * runner.addDefaultOptimizationPasses().run();
 * ```
 *
 * @license MIT
 */

export {
  createPass,
  defaultPassOptions,
  listPasses,
  PassRunner,
  registerPass,
  shrinkPassOptions,
} from "./pass.ts";
export type { Pass, PassCtor, PassOptions } from "./pass.ts";

// Side-effect imports: register all built-in passes.
import "./dce.ts";
import "./vacuum.ts";
import "./optimize-instructions.ts";
import "./remove-unused-brs.ts";
import "./simplify-locals.ts";
import "./coalesce-locals.ts";
import "./local-cse.ts";
import "./remove-unused-module-elements.ts";
import "./pick-load-signs.ts";
import "./inlining.ts";
import "./remove-unused-names.ts";
import "./strip-eh.ts";
import "./flatten.ts";
