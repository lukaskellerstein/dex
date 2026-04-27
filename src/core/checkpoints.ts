/**
 * What: Back-compat re-export shim. The implementation now lives in `./checkpoints/` (one sub-file per concept). New code should `import { checkpoints }` for the namespace object; existing flat imports continue to work via `export *`.
 * Not: Does not contain logic. Do not add anything here — it's a stable surface, not a dumping ground.
 * Deps: ./checkpoints/index.js.
 */

export * from "./checkpoints/index.js";
