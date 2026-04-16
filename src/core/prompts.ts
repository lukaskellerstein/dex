import type { RunConfig, Phase } from "./types.js";

// ── T005a: Product Domain Clarification Prompt ──

export function buildProductClarificationPrompt(goalFilePath: string): string {
  return `You are conducting the PRODUCT clarification session for a software project. The user has provided an initial project description in GOAL.md. Your job is to read it, identify gaps in the product definition, and ask clarifying questions focused exclusively on the product domain.

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

When using AskUserQuestion, ALWAYS mark exactly one option as recommended per question by setting \`recommended: true\` on that option. Choose the recommendation based on the project context from GOAL.md — pick the option that best fits the described project. This is critical for automatic clarification mode where the recommended options are auto-selected.

## Completeness Checklist

Before writing the output, verify you have answers for ALL of these:
- [ ] User personas/roles identified
- [ ] User stories with acceptance criteria per major feature
- [ ] Feature list with clear priorities (MVP vs. later)
- [ ] Data model overview (key entities and relationships)
- [ ] Scope boundaries (what's in, what's out)

## Output

When you have sufficient information, write the product domain output to \`GOAL_product_domain.md\` in the project root using the Write tool. Structure it as clear markdown sections covering all checklist items.

Do NOT modify the original GOAL.md — it is the user's input and must be preserved.

After writing the file, output the absolute path to GOAL_product_domain.md as the final line of your response.`;
}

// ── T005b: Technical Domain Clarification Prompt ──

export function buildTechnicalClarificationPrompt(
  goalFilePath: string,
  productDomainPath: string
): string {
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

When using AskUserQuestion, ALWAYS mark exactly one option as recommended per question by setting \`recommended: true\` on that option. Choose the recommendation based on the project context from GOAL.md and the product domain output — pick the option that best fits the described project. This is critical for automatic clarification mode where the recommended options are auto-selected.

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

When you have sufficient information, write the technical domain output to \`GOAL_technical_domain.md\` in the project root using the Write tool. Structure it as clear markdown sections covering all checklist items.

Do NOT modify the original GOAL.md or GOAL_product_domain.md.

After writing the file, output the absolute path to GOAL_technical_domain.md as the final line of your response.`;
}

// ── T005c: Clarification Synthesis Prompt ──

export function buildClarificationSynthesisPrompt(
  goalFilePath: string,
  productDomainPath: string,
  technicalDomainPath: string
): string {
  return `You are synthesizing the results of a multi-domain clarification session into two output files. No interactive Q&A is needed — all information has been collected.

## Instructions

1. Read the original project description at: ${goalFilePath}
2. Read the product domain decisions at: ${productDomainPath}
3. Read the technical domain decisions at: ${technicalDomainPath}
4. Produce TWO output files:

### Output 1: GOAL_clarified.md

Write \`GOAL_clarified.md\` in the project root. This is the comprehensive, unified project plan and the single source of truth for all subsequent specification and implementation work. It must include:

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

- Do NOT modify GOAL.md, GOAL_product_domain.md, or GOAL_technical_domain.md
- Do NOT ask interactive questions — synthesize from existing inputs only
- After writing both files, output the absolute path to GOAL_clarified.md as the final line of your response.`;
}

// ── T006: Gap Analysis Prompt ──

export function buildGapAnalysisPrompt(
  config: RunConfig,
  fullPlanPath: string,
  existingSpecs: string[]
): string {
  const specList = existingSpecs.length > 0
    ? existingSpecs.map((s) => `  - ${s}`).join("\n")
    : "  (none yet)";

  return `You are a gap analysis agent for the Dex autonomous loop. Your job is to compare the full project plan against existing feature specifications and determine what to do next.

## Instructions

1. Read the full plan at: ${fullPlanPath}
2. Review each existing spec directory listed below for completeness (check for spec.md, plan.md, tasks.md, and implementation status)
3. Determine the next action

## Existing Spec Directories

${specList}

## Project Directory

${config.projectDir}

## Decision Rules

- If a feature in the full plan has NO corresponding spec directory: output \`NEXT_FEATURE: {feature_name} | {one-line description}\`
- If a feature has a spec directory with tasks.md but incomplete implementation: output \`RESUME_FEATURE: {spec_dir_relative_path}\`
- If a feature's implementation has failed and needs re-planning: output \`REPLAN_FEATURE: {spec_dir_relative_path}\`
- If ALL features in the full plan have been implemented and verified: output \`GAPS_COMPLETE\`

## Scope Constraints

- Only consider features explicitly described in GOAL.md
- Do not invent new features or expand scope
- Process features in the order they appear in the plan

## Output Format

Output EXACTLY ONE of these lines as your final output (no markdown formatting, no code blocks):

NEXT_FEATURE: {name} | {description}
RESUME_FEATURE: {specDir}
REPLAN_FEATURE: {specDir}
GAPS_COMPLETE`;
}

// ── T007: Constitution Prompt ──

export function buildConstitutionPrompt(
  config: RunConfig,
  fullPlanPath: string
): string {
  return `/speckit-constitution

Read the full project plan at ${fullPlanPath} and the project instructions at ${config.projectDir}/CLAUDE.md for detailed technical context about the project being built. The project directory is ${config.projectDir}.`;
}

// ── T008: Specify Prompt ──

export function buildSpecifyPrompt(
  config: RunConfig,
  featureName: string,
  featureDescription: string
): string {
  return `/speckit-specify

Feature name: ${featureName}
Feature description: ${featureDescription}

Project directory: ${config.projectDir}`;
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

// ── T011: Verify Prompt ──

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

Report what passed and what failed. If everything passes, confirm verification is complete.
If there are failures, describe each failure clearly so the next cycle can fix them.`;
}

// ── T012: Learnings Prompt ──

export function buildLearningsPrompt(
  config: RunConfig,
  specDir: string
): string {
  return `You are a learnings agent. Review the work done on the spec at ${specDir} and extract operational insights.

## Instructions

1. Read the spec, plan, and implementation files in ${specDir}
2. Identify patterns that worked well or caused problems
3. Update \`.claude/rules/learnings.md\` with operational insights that will help future cycles

## Project Directory

${config.projectDir}

## Guidelines

- Focus on actionable, project-specific insights
- Note any workarounds or gotchas discovered
- Record technology-specific patterns (build quirks, API behaviors)
- Keep entries concise — one line per insight
- Append to existing content, don't overwrite`;
}

// ── T013: Implement Prompt ──

export function buildImplementPrompt(
  config: RunConfig,
  phase: Phase,
  fullPlanPath: string
): string {
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  return `/speckit-implement ${specPath} --phase ${phase.number}

## Dex Loop Guardrails

- Read ${fullPlanPath} for full project context (READ-ONLY — do not modify GOAL.md or GOAL_clarified.md)
- Orient: You are implementing Phase ${phase.number}: ${phase.name}
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md
- Run build/typecheck after each logical group of changes
- If a task fails, log the error and move to the next task
- Do not spawn more than 3 subagents concurrently
- Commit after completing the phase: git add -A -- ':!.dex/' && git commit -m "Phase ${phase.number}: ${phase.name}"`;
}
