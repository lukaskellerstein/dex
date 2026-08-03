/**
 * What: Node module-resolution hook that maps relative `./foo.js` specifiers to
 *       `./foo.ts` when the .ts file exists on disk.
 * Why:  tsconfig uses "module": "NodeNext", so source files must import each
 *       other with the `.js` extension the compiled output will have. Node's
 *       `--experimental-strip-types` runs the .ts sources directly and does NOT
 *       perform that remap, so any *value* import of a sibling module fails with
 *       ERR_MODULE_NOT_FOUND. (Type-only imports are erased before resolution,
 *       which is why some suites appeared to work and others did not.)
 * Not:  Not a transpiler and not a substitute for `tsc`. It only rewrites the
 *       specifier; Node still does the type stripping.
 * Use:  node --import ./scripts/ts-resolve-hook.mjs --test ...
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && /^\.\.?\//.test(specifier) && context.parentURL) {
      try {
        const candidate = fileURLToPath(new URL(specifier, context.parentURL)).replace(
          /\.js$/,
          ".ts",
        );
        if (existsSync(candidate)) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
      } catch {
        // Non-file URL (node:, data:, http:) — fall through to default resolution.
      }
    }
    return nextResolve(specifier, context);
  },
});
