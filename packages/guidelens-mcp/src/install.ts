import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SUPPORTED_AGENTS, SupportedAgent } from "./types.js";

export interface AgentConfigInfo {
  agent: SupportedAgent;
  displayName: string;
  configPath: string;
  format: "json" | "toml";
  snippet: string;
  serverEntry: {
    command: string;
    args: string[];
  };
}

export function isSupportedAgent(value: string): value is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value.toLowerCase());
}

export function getAgentDefaultConfigPath(
  agent: SupportedAgent,
  homeDir: string = os.homedir()
): string {
  switch (agent) {
    case "claude":
      return path.join(homeDir, ".claude.json");
    case "codex":
      return path.join(homeDir, ".codex", "config.toml");
    case "gemini":
      return path.join(homeDir, ".gemini", "settings.json");
    case "antigravity":
      return path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    case "hermes":
      return path.join(homeDir, ".hermes", "mcp.json");
  }
}

export function getAgentDisplayName(agent: SupportedAgent): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "OpenAI Codex CLI";
    case "gemini":
      return "Gemini CLI";
    case "antigravity":
      return "Google Antigravity";
    case "hermes":
      return "Hermes Agent";
  }
}

export function getAgentConfigInfo(
  agentInput: string,
  options: { homeDir?: string; configPath?: string; command?: string } = {}
): AgentConfigInfo {
  const normalized = agentInput.trim().toLowerCase();
  if (!isSupportedAgent(normalized)) {
    throw new Error(
      `Unsupported agent "${agentInput}". Expected one of: ${SUPPORTED_AGENTS.join(", ")}`
    );
  }

  const agent: SupportedAgent = normalized;
  const homeDir = options.homeDir ?? os.homedir();
  const configPath =
    options.configPath ?? getAgentDefaultConfigPath(agent, homeDir);
  const command = options.command ?? "guidelens";
  const args = ["mcp"];

  if (agent === "codex") {
    const snippet = [
      `[mcp_servers.guidelens]`,
      `command = "${command}"`,
      `args = ["mcp"]`,
    ].join("\n");

    return {
      agent,
      displayName: getAgentDisplayName(agent),
      configPath,
      format: "toml",
      snippet,
      serverEntry: { command, args },
    };
  }

  const jsonObj = {
    mcpServers: {
      guidelens: {
        command,
        args,
      },
    },
  };

  return {
    agent,
    displayName: getAgentDisplayName(agent),
    configPath,
    format: "json",
    snippet: JSON.stringify(jsonObj, null, 2),
    serverEntry: { command, args },
  };
}

export async function writeAgentConfig(
  agentInput: string,
  options: { homeDir?: string; configPath?: string; command?: string } = {}
): Promise<{ info: AgentConfigInfo; writtenPath: string }> {
  const info = getAgentConfigInfo(agentInput, options);
  const targetPath = info.configPath;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (info.format === "toml") {
    let existing = "";
    try {
      existing = await fs.readFile(targetPath, "utf8");
    } catch {
      existing = "";
    }

    const sectionHeader = "[mcp_servers.guidelens]";
    let updated: string;
    if (existing.includes(sectionHeader)) {
      const regex = /\[mcp_servers\.guidelens\][\s\S]*?(?=\r?\n\[|$)/;
      updated = existing.replace(regex, info.snippet);
    } else {
      const prefix =
        existing.trim().length > 0 ? `${existing.trimEnd()}\n\n` : "";
      updated = `${prefix}${info.snippet}\n`;
    }

    await fs.writeFile(targetPath, updated, "utf8");
    return { info, writtenPath: targetPath };
  }

  // JSON format merge
  let root: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    root = {};
  }

  const existingServers =
    root.mcpServers &&
    typeof root.mcpServers === "object" &&
    !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};

  root.mcpServers = {
    ...existingServers,
    guidelens: info.serverEntry,
  };

  await fs.writeFile(targetPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return { info, writtenPath: targetPath };
}
