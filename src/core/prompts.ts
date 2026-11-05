/**
 * What: The project-level prompts of a new project's first run (clarification, synthesis, manifest extraction, constitution) with their structured-output schemas, and `stageEnv`, the agent environment of a per-entry stage (research R5).
 * Not: The per-entry stage prompts (brief → verify) live in entry-prompts.ts (016 research R18).
 * Deps: node:path; queue types, config types.
 */

import path from "node:path";
import type { ResolvedEntry, StageName } from "./queue.js";
import type { RunConfig } from "./types.js";

// ── Structured Output Schemas ──

export const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "Feature number from the priority table (1, 2, 3...)",
          },
          title: { type: "string", description: "Feature name from the priority table" },
          description: {
            type: "string",
            description:
              "Rich description including user stories, acceptance criteria, relevant data model entities, and scope constraints",
          },
        },
        required: ["id", "title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["features"],
  additionalProperties: false,
} as const;

export const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    filesProduced: {
      type: "array",
      items: { type: "string" },
      description: "Relative paths of files created or updated during synthesis",
    },
    goalClarifiedPath: { type: "string", description: "Relative path to the clarified goal file" },
  },
  required: ["filesProduced", "goalClarifiedPath"],
  additionalProperties: false,
} as const;

// ── T005a: Product Domain Clarification Prompt ──

export function buildProductClarificationPrompt(
  goalFilePath: string,
  productDomainPath: string,
): string {
  const goalName = path.basename(goalFilePath);
  return `You are conducting the PRODUCT clarification session for a software project. The user has provided an initial project description in ${goalName}. Your job is to read it, identify gaps in the product definition, and ask clarifying questions focused exclusively on the product domain.

## Instructions

1. Read the user's initial plan at: ${goalFilePath}
2. Identify what is missing or ambiguous about the PRODUCT
3. Ask the user clarifying questions using the AskUserQuestion tool until you have enough information. Cover ONLY these areas:

   - **User Stories & Personas**: Who are the users? What are their goals and primary workflows?
   - **Features & Functional Requirements**: What features are needed? What are the acceptance criteria for each?
   - **Data Model**: Key entities, relationships, and data flows
   - **Scope Boundaries**: What is explicitly IN scope and OUT of scope?
   - **Prioritization**: Which features are MVP vs. nice-to-have?

Do NOT ask about technology stack, deployment, testing strategy, or build commands — those will be covered in a separate technical clarification session.

## Question Format Rules

When using AskUserQuestion, ALWAYS mark exactly one option as recommended per question by setting \`recommended: true\` on that option. Choose the recommendation based on the project context from ${goalName} — pick the option that best fits the described project. This is critical for automatic clarification mode where the recommended options are auto-selected.

## Completeness Checklist

Before writing the output, verify you have answers for ALL of these:
- [ ] User personas/roles identified
- [ ] User stories with acceptance criteria per major feature
- [ ] Feature list with clear priorities (MVP vs. later)
- [ ] Data model overview (key entities and relationships)
- [ ] Scope boundaries (what's in, what's out)

## Output

When you have sufficient information, write the product domain output to the absolute path \`${productDomainPath}\` using the Write tool. This path sits next to the goal file — do NOT relocate it to the project root or any other directory. Structure the file as clear markdown sections covering all checklist items.

Do NOT modify the original ${goalName} — it is the user's input and must be preserved.

After writing the file, output the absolute path \`${productDomainPath}\` as the final line of your response.`;
}

// ── T005b: Technical Domain Clarification Prompt ──

export function buildTechnicalClarificationPrompt(
  goalFilePath: string,
  productDomainPath: string,
  technicalDomainPath: string,
): string {
  const goalName = path.basename(goalFilePath);
  const productDomainName = path.basename(productDomainPath);
  return `You are conducting the TECHNICAL clarification session for a software project. The product domain has already been clarified. Your job is to read the product decisions and ask clarifying questions focused exclusively on the technical domain.

## Instructions

1. Read the original project description at: ${goalFilePath}
2. Read the product domain decisions at: ${productDomainPath}
3. Identify what is missing or ambiguous about the TECHNICAL implementation
4. Ask the user clarifying questions using the AskUserQuestion tool until you have enough information. Cover ONLY these areas:

   - **Technology Stack**: Languages, frameworks, libraries with specific versions
   - **Architecture**: Monolith vs. microservices, API patterns (REST, GraphQL, etc.), state management
   - **Build/Test/Dev Commands**: How to build, test, and run the project locally
   - **Deployment**: Target platform (local, cloud provider, container, serverless), CI/CD approach
   - **Testing Strategy**: Unit, integration, e2e approach and tools
   - **Non-Functional Requirements**: Performance targets, scalability limits, security constraints
   - **Infrastructure**: Database, caching, message queues, external services/APIs

Do NOT re-ask product questions (features, user stories, scope) — those are already decided in the product domain output.

## Question Format Rules

When using AskUserQuestion, ALWAYS mark exactly one option as recommended per question by setting \`recommended: true\` on that option. Choose the recommendation based on the project context from ${goalName} and the product domain output — pick the option that best fits the described project. This is critical for automatic clarification mode where the recommended options are auto-selected.

## Completeness Checklist

Before writing the output, verify you have answers for ALL of these:
- [ ] Technology stack with specific versions (language, framework, key libraries)
- [ ] Architecture pattern and key decisions
- [ ] Build, test, and dev commands
- [ ] Deployment target and approach
- [ ] Testing strategy (unit, integration, e2e tools)
- [ ] Non-functional requirements (performance, security)
- [ ] Infrastructure dependencies (database, external services)

## Output

When you have sufficient information, write the technical domain output to the absolute path \`${technicalDomainPath}\` using the Write tool. This path sits next to the goal file — do NOT relocate it to the project root or any other directory. Structure the file as clear markdown sections covering all checklist items.

Do NOT modify the original ${goalName} or ${productDomainName}.

After writing the file, output the absolute path \`${technicalDomainPath}\` as the final line of your response.`;
}

// ── T005c: Clarification Synthesis Prompt ──

export function buildClarificationSynthesisPrompt(
  goalFilePath: string,
  productDomainPath: string,
  technicalDomainPath: string,
  clarifiedPath: string,
): string {
  const goalName = path.basename(goalFilePath);
  const productDomainName = path.basename(productDomainPath);
  const technicalDomainName = path.basename(technicalDomainPath);
  const clarifiedName = path.basename(clarifiedPath);
  return `You are synthesizing the results of a multi-domain clarification session into two output files. No interactive Q&A is needed — all information has been collected.

## Instructions

1. Read the original project description at: ${goalFilePath}
2. Read the product domain decisions at: ${productDomainPath}
3. Read the technical domain decisions at: ${technicalDomainPath}
4. Produce TWO output files:

### Output 1: ${clarifiedName}

Write the clarified plan to the absolute path \`${clarifiedPath}\` using the Write tool. This path sits next to the goal file — do NOT relocate it to the project root or any other directory. This is the comprehensive, unified project plan and the single source of truth for all subsequent specification and implementation work. It must include:

- Project overview and vision
- User personas and stories with acceptance criteria
- Feature breakdown with priorities
- Data model overview
- Technology stack with versions
- Architecture decisions
- Build, test, and dev commands
- Deployment target and approach
- Testing strategy
- Non-functional requirements
- Scope boundaries

Use structured markdown with clear sections and subsections. Use mermaid diagrams where they add clarity (data model, architecture, user flows).

### Output 2: CLAUDE.md

Write \`CLAUDE.md\` in the project root. This file provides instructions and rules for AI agents working on this project. It must include:

- **Project name and one-line description**
- **Technology stack** — languages, frameworks, key libraries with versions
- **Architecture** — pattern, key constraints, folder structure expectations
- **Commands** — build, test, dev, lint commands
- **Code style** — conventions, patterns to follow, patterns to avoid
- **Testing** — strategy, tools, coverage expectations
- **Deployment** — target, CI/CD expectations
- **Key constraints** — non-negotiable rules derived from technical decisions

Keep CLAUDE.md concise and directive — it's an instruction file, not documentation. Use imperative language ("Use X", "Always Y", "Never Z").

## Important

- Do NOT modify ${goalName}, ${productDomainName}, or ${technicalDomainName}
- Do NOT ask interactive questions — synthesize from existing inputs only
- After writing both files, output the absolute path \`${clarifiedPath}\` as the final line of your response.`;
}

// ── Manifest Extraction Prompt ──

export function buildManifestExtractionPrompt(goalPath: string): string {
  return `Read the project plan at ${goalPath}. Extract every MVP feature listed in the feature priority table.

For each feature, produce:
- id: the feature number from the table (1, 2, 3...)
- title: the feature name exactly as it appears in the table (e.g., "Product Catalog")
- description: a rich, self-contained description that includes:
  - The one-line description from the priority table
  - All related user stories with their full acceptance criteria
  - Relevant data model entities and their relationships
  - Any scope constraints or out-of-scope items that apply to this feature

The description must be detailed enough that someone reading ONLY that description can write a complete feature specification. Do NOT include technology stack details — focus on WHAT the feature does, not HOW it is built.

Process features in the exact order they appear in the priority table. Do not skip features. Do not invent new features.`;
}

// ── T007: Constitution Prompt ──

export function buildConstitutionPrompt(config: RunConfig, fullPlanPath: string): string {
  return `/speckit-constitution

Read the full project plan at ${fullPlanPath} and the project instructions at ${config.projectDir}/CLAUDE.md for detailed technical context about the project being built. The project directory is ${config.projectDir}.`;
}

/** The agent environment for a stage (research R5). */
export function stageEnv(
  entry: ResolvedEntry,
  stage: StageName,
  kind: "new" | "existing",
): Record<string, string> {
  if (stage === "brief") return {};
  // spec-kit reads these before .specify/feature.json. NO_PERSIST asks it not to rewrite that
  // tracked file; spec-kit 1.2.5 does not read it yet (research R5).
  const env: Record<string, string> = {
    SPECIFY_FEATURE: entry.branch,
    SPECIFY_FEATURE_DIRECTORY: entry.specDir,
    SPECIFY_FEATURE_NO_PERSIST: "1",
  };
  if (stage === "specify" && kind === "existing") env.GIT_BRANCH_NAME = entry.branch;
  return env;
}
