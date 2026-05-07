import path from "node:path";
import type { RunConfig, TaskPhase } from "./types.js";

// ── Structured Output Schemas ──

export const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number", description: "Feature number from the priority table (1, 2, 3...)" },
          title: { type: "string", description: "Feature name from the priority table" },
          description: { type: "string", description: "Rich description including user stories, acceptance criteria, relevant data model entities, and scope constraints" },
        },
        required: ["id", "title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["features"],
  additionalProperties: false,
} as const;

export const GAP_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["RESUME_FEATURE", "REPLAN_FEATURE"] },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
  additionalProperties: false,
} as const;

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean", description: "true if ALL acceptance criteria pass and build/tests succeed" },
    buildSucceeded: { type: "boolean", description: "true if the project compiles without errors" },
    testsSucceeded: { type: "boolean", description: "true if all tests pass (or no tests exist)" },
    failures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string", description: "The acceptance criterion or check that failed" },
          description: { type: "string", description: "What went wrong and what was expected" },
          severity: { type: "string", enum: ["blocking", "minor"] },
        },
        required: ["criterion", "description", "severity"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", description: "One-paragraph summary of verification results" },
  },
  required: ["passed", "buildSucceeded", "testsSucceeded", "failures", "summary"],
  additionalProperties: false,
} as const;

export const LEARNINGS_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["build", "testing", "api", "architecture", "tooling", "workaround"] },
          insight: { type: "string", description: "One-line actionable insight" },
          context: { type: "string", description: "Brief context for when this applies" },
        },
        required: ["category", "insight", "context"],
        additionalProperties: false,
      },
    },
  },
  required: ["insights"],
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
  const productDomainName = path.basename(productDomainPath);
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
  const technicalDomainName = path.basename(technicalDomainPath);
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

// ── Feature Evaluation Prompt (RESUME vs REPLAN) ──

export function buildFeatureEvaluationPrompt(
  config: RunConfig,
  specDir: string
): string {
  return `You are evaluating whether a partially-completed feature should be resumed or replanned.

## Instructions

1. Read the spec at: ${specDir}/spec.md
2. Read the plan at: ${specDir}/plan.md
3. Read the tasks at: ${specDir}/tasks.md
4. Check the current state of the implementation — which tasks are done, which remain
5. Assess whether the existing plan is still viable or needs replanning

## Decision criteria

Choose RESUME_FEATURE if:
- The plan is sound and remaining tasks are clearly defined
- Progress has been made and continuing makes sense
- No fundamental design issues have been discovered

Choose REPLAN_FEATURE if:
- The plan has structural problems that make remaining tasks unworkable
- Key assumptions in the plan turned out to be wrong
- The implementation has diverged significantly from the plan

## Project Directory

${config.projectDir}`;
}

// ── Verify Fix Prompt ──

export function buildVerifyFixPrompt(
  config: RunConfig,
  specDir: string,
  failures: Array<{ criterion: string; description: string; severity: string }>
): string {
  const failureList = failures
    .map((f, i) => `${i + 1}. **${f.criterion}**: ${f.description}`)
    .join("\n");

  return `You are a fix agent. The verification stage found blocking failures in the implementation at ${specDir}.

## Failures to fix

${failureList}

## Instructions

1. Read the relevant code and spec
2. Fix each blocking failure
3. Run the build to verify your fixes compile
4. Do not introduce new features — only fix the listed failures

## Project Directory

${config.projectDir}`;
}

// ── T007: Constitution Prompt ──

export function buildConstitutionPrompt(
  config: RunConfig,
  fullPlanPath: string
): string {
  return `/speckit-constitution

Read the full project plan at ${fullPlanPath} and the project instructions at ${config.projectDir}/CLAUDE.md for detailed technical context about the project being built. The project directory is ${config.projectDir}.`;
}

// ── Specify Prompt ──

export function buildSpecifyPrompt(
  featureName: string,
  featureDescription: string
): string {
  return `/speckit-specify ${featureName}: ${featureDescription}`;
}

// ── T009: Loop Plan Prompt ──

export function buildLoopPlanPrompt(
  config: RunConfig,
  specPath: string
): string {
  return `/speckit-plan ${specPath}`;
}

// ── T010: Loop Tasks Prompt ──

export function buildLoopTasksPrompt(
  config: RunConfig,
  specPath: string
): string {
  return `/speckit-tasks ${specPath}`;
}

// ── Verify Prompt ──

export function buildVerifyPrompt(
  config: RunConfig,
  specDir: string,
  fullPlanPath: string
): string {
  return `You are a verification agent. Your job is to verify that the implementation in the project matches the specification.

## Instructions

1. Read the spec at: ${specDir}/spec.md
2. Read the plan at: ${specDir}/plan.md
3. Read the full project plan at: ${fullPlanPath} for testing strategy
4. Run the build command to verify the project compiles
5. Run tests if they exist
6. Check that all acceptance criteria from the spec are met
7. If browser-based verification is needed, use the available MCP tools

## Project Directory

${config.projectDir}

## Output

Your structured output must accurately reflect what you observed. Set passed=true ONLY if the build succeeds, tests pass, AND all acceptance criteria are met. For each failure, classify severity:
- "blocking": the feature is incomplete or broken — must fix before marking complete
- "minor": cosmetic issues, missing polish, non-critical deviations`;
}

// ── Learnings Prompt ──

export function buildLearningsPrompt(
  config: RunConfig,
  specDir: string
): string {
  return `You are a learnings agent. Review the work done on the spec at ${specDir} and extract operational insights.

## Instructions

1. Read the spec, plan, and implementation files in ${specDir}
2. Identify patterns that worked well or caused problems
3. Return structured insights — do NOT modify any files directly

## Project Directory

${config.projectDir}

## Guidelines

- Focus on actionable, project-specific insights
- Note any workarounds or gotchas discovered
- Record technology-specific patterns (build quirks, API behaviors)
- Each insight should be one concise line
- Categorize each insight: build, testing, api, architecture, tooling, or workaround
- Include brief context for when the insight applies`;
}

// ── T013: Implement Prompt ──

export function buildImplementPrompt(
  config: RunConfig,
  phase: TaskPhase,
  fullPlanPath: string
): string {
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const goalName = config.descriptionFile ? path.basename(config.descriptionFile) : "GOAL.md";
  const clarifiedName = path.basename(fullPlanPath);

  return `/speckit-implement ${specPath} --phase ${phase.number}

## Dex Loop Guardrails

- Read ${fullPlanPath} for full project context (READ-ONLY — do not modify ${goalName} or ${clarifiedName})
- Orient: You are implementing TaskPhase ${phase.number}: ${phase.name}
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md
- Run build/typecheck after each logical group of changes
- If a task fails, log the error and move to the next task
- Do not spawn more than 3 subagents concurrently
- Commit after completing the phase: git add -A -- ':!.dex/' && git commit -m "TaskPhase ${phase.number}: ${phase.name}"`;
}
