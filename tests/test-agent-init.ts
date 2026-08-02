#!/usr/bin/env npx tsx
/**
 * Test script: Agent Init Diagnostics
 *
 * Spawns a Claude Code agent via the SDK and captures the system init message
 * to see what skills, plugins, tools, agents, and slash commands are available.
 * Then sends a simple prompt to verify if the Skill tool gets invoked.
 *
 * Usage:
 *   npx tsx tests/test-agent-init.ts [project-dir]
 *
 * Default project-dir: /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
 */

const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const GREEN = "\x1b[92m";
const MAGENTA = "\x1b[95m";
const RED = "\x1b[91m";
const BLUE = "\x1b[94m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(category: string, message: string): void {
  const colors: Record<string, string> = {
    CONFIG: BLUE,
    SKILL: YELLOW,
    PLUGIN: CYAN,
    AGENT: MAGENTA,
    TOOL: GREEN,
    TEXT: DIM,
    RESULT: GREEN,
    INIT: BLUE,
    MCP: BLUE,
    PASS: GREEN,
    FAIL: RED,
    WARN: YELLOW,
    SLASH: YELLOW,
  };
  const color = colors[category] ?? RESET;
  console.log(`  ${color}[${category}]${RESET} ${message}`);
}

async function main(): Promise<void> {
  const projectDir =
    process.argv[2] ?? "/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce";

  console.log(`\n${BOLD}Dex Agent Init Diagnostics${RESET}`);
  console.log("─".repeat(60) + "\n");

  log("CONFIG", `Project dir: ${projectDir}`);
  log("CONFIG", `Model: opus`);
  log("CONFIG", `Setting sources: ["project"]`);

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // A simple prompt that should trigger the Skill tool
  const prompt =
    'Use the Skill tool to invoke "speckit-implement" with args "specs/001-product-catalog --phase 1". If the Skill tool is not available, list all tools you have access to.';

  log("CONFIG", `Prompt: ${prompt.slice(0, 100)}...`);

  console.log(`\n${BOLD}Spawning agent...${RESET}\n`);

  let sessionId: string | null = null;
  let systemInitReceived = false;
  const toolsUsed = new Set<string>();
  let skillInvoked = false;
  let turnCount = 0;

  for await (const msg of query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      cwd: projectDir,
      maxTurns: 3,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
    },
  })) {
    const message = msg as Record<string, unknown>;

    // Capture session ID
    if (!sessionId && typeof message.session_id === "string") {
      sessionId = message.session_id;
      log("INIT", `Session ID: ${sessionId}`);
    }

    // ── System init message ──
    if (message.type === "system" && !systemInitReceived) {
      systemInitReceived = true;

      const model = message.model as string | undefined;
      const tools = message.tools as Array<Record<string, unknown>> | undefined;
      const skills = message.skills as unknown[] | undefined;
      const plugins = message.plugins as unknown[] | undefined;
      const agents = message.agents as unknown[] | undefined;
      const slashCommands = message.slash_commands as unknown[] | undefined;
      const mcpServers = message.mcp_servers as unknown[] | undefined;

      console.log(`\n${BOLD}System Init Message${RESET}`);
      console.log("─".repeat(60));

      log("INIT", `Model: ${model ?? "?"}`);
      log("INIT", `Tools: ${tools?.length ?? 0}`);

      // Skills
      console.log(`\n  ${YELLOW}${BOLD}/skills (${skills?.length ?? 0})${RESET}`);
      if (skills && skills.length > 0) {
        for (const s of skills) {
          const name =
            typeof s === "object" && s !== null
              ? ((s as Record<string, unknown>).name ?? JSON.stringify(s))
              : String(s);
          log("SKILL", `  ${name}`);
        }
      } else {
        log("WARN", "  (none) — agent cannot invoke any skills!");
      }

      // Plugins
      console.log(`\n  ${CYAN}${BOLD}/plugins (${plugins?.length ?? 0})${RESET}`);
      if (plugins && plugins.length > 0) {
        for (const p of plugins) {
          const name =
            typeof p === "object" && p !== null
              ? ((p as Record<string, unknown>).name ?? JSON.stringify(p))
              : String(p);
          log("PLUGIN", `  ${name}`);
        }
      } else {
        log("WARN", "  (none)");
      }

      // Agents
      console.log(`\n  ${MAGENTA}${BOLD}/agents (${agents?.length ?? 0})${RESET}`);
      if (agents && agents.length > 0) {
        for (const a of agents) {
          const name =
            typeof a === "object" && a !== null
              ? ((a as Record<string, unknown>).name ?? JSON.stringify(a))
              : String(a);
          log("AGENT", `  ${name}`);
        }
      } else {
        log("WARN", "  (none)");
      }

      // Slash commands
      console.log(`\n  ${YELLOW}${BOLD}/slash_commands (${slashCommands?.length ?? 0})${RESET}`);
      if (slashCommands && slashCommands.length > 0) {
        for (const sc of slashCommands) {
          const name =
            typeof sc === "object" && sc !== null
              ? ((sc as Record<string, unknown>).name ?? JSON.stringify(sc))
              : String(sc);
          log("SLASH", `  ${name}`);
        }
      } else {
        log("WARN", "  (none)");
      }

      // MCP servers
      if (mcpServers && mcpServers.length > 0) {
        console.log(`\n  ${BLUE}${BOLD}MCP servers (${mcpServers.length})${RESET}`);
        for (const m of mcpServers) {
          const name =
            typeof m === "object" && m !== null
              ? ((m as Record<string, unknown>).name ?? JSON.stringify(m))
              : String(m);
          log("MCP", `  ${name}`);
        }
      }

      // Tool list — check if Skill tool is present
      if (tools) {
        const toolNames = tools.map((t) => String(t.name ?? t));
        const hasSkillTool = toolNames.includes("Skill");
        console.log(
          `\n  ${GREEN}${BOLD}Skill tool present: ${hasSkillTool ? `${GREEN}YES` : `${RED}NO`}${RESET}`,
        );
        if (!hasSkillTool) {
          log("FAIL", "The Skill tool is NOT in the tool list — agent cannot call it!");
          log("WARN", `Available tools: ${toolNames.join(", ")}`);
        }
      }

      console.log("\n" + "─".repeat(60));
    }

    // ── Track tool usage ──
    if (message.type === "assistant") {
      turnCount++;
      const innerMsg = message.message as Record<string, unknown> | undefined;
      const content = innerMsg?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const preview = (block.text as string).slice(0, 200);
            log("TEXT", preview + (block.text.length > 200 ? "..." : ""));
          }
          if (block.type === "tool_use") {
            const toolName = String(block.name ?? "?");
            toolsUsed.add(toolName);
            if (toolName === "Skill") {
              skillInvoked = true;
              const input = block.input as Record<string, unknown> | undefined;
              log(
                "SKILL",
                `>>> Skill invoked: ${input?.skill ?? "?"} (args: ${input?.args ?? ""})`,
              );
            } else {
              log("TOOL", toolName);
            }
          }
        }
      }
    }

    // ── Result ──
    if (message.type === "result") {
      const cost = message.total_cost_usd;
      const duration = message.duration_ms;
      console.log(`\n${BOLD}Result${RESET}`);
      console.log("─".repeat(60));
      log("RESULT", `Cost: $${typeof cost === "number" ? cost.toFixed(4) : "?"}`);
      log("RESULT", `Duration: ${duration ?? "?"}ms`);
      log("RESULT", `Turns: ${turnCount}`);
      log("RESULT", `Tools used: ${[...toolsUsed].join(", ") || "none"}`);
    }
  }

  // ── Validation ──
  console.log(`\n${BOLD}Validation${RESET}`);
  console.log("─".repeat(60));

  if (!systemInitReceived) {
    log("FAIL", "No system init message received — cannot determine available tools");
  }

  if (skillInvoked) {
    log("PASS", "Skill tool was invoked");
  } else {
    log("FAIL", "Skill tool was NOT invoked");
    if (toolsUsed.size > 0) {
      log("WARN", `Agent used these tools instead: ${[...toolsUsed].join(", ")}`);
    }
  }

  console.log();
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
