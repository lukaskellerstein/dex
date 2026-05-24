/**
 * What: Derive the four goal-related artefact paths (goal + clarified + product
 *       domain + technical domain) from a single user-supplied goal file path.
 *       Single source of truth so the basename `GOAL` isn't hardcoded across
 *       the codebase — users may point at e.g. `PROJECT.md` or `MY_GOAL.md`.
 * Not:  Does not read or write the filesystem. Does not validate that any of
 *       the derived files exist.
 */

import path from "node:path";

export interface GoalPaths {
  goal: string;
  clarified: string;
  productDomain: string;
  technicalDomain: string;
}

const DERIVATIVE_SUFFIXES = ["_clarified", "_product_domain", "_technical_domain"] as const;

/**
 * Split `goalPath` into its directory and stem and produce the three derivative
 * artefact paths alongside it. `MY_GOAL.md` → `MY_GOAL_clarified.md`,
 * `MY_GOAL_product_domain.md`, `MY_GOAL_technical_domain.md` in the same dir.
 *
 * Throws when the stem already ends with one of the derivative suffixes — that
 * would produce a self-colliding path (e.g. `FOO_clarified_clarified.md`).
 */
export function deriveGoalPaths(goalPath: string): GoalPaths {
  const dir = path.dirname(goalPath);
  const ext = path.extname(goalPath) || ".md";
  const stem = path.basename(goalPath, ext);

  if (!stem) {
    throw new Error(`Goal file path has no basename: ${goalPath}`);
  }
  for (const suffix of DERIVATIVE_SUFFIXES) {
    if (stem.endsWith(suffix)) {
      throw new Error(
        `Goal file '${stem}${ext}' collides with derivative naming. Pick a name that doesn't end in ${DERIVATIVE_SUFFIXES.join(", ")}.`,
      );
    }
  }

  return {
    goal: goalPath,
    clarified: path.join(dir, `${stem}_clarified${ext}`),
    productDomain: path.join(dir, `${stem}_product_domain${ext}`),
    technicalDomain: path.join(dir, `${stem}_technical_domain${ext}`),
  };
}
