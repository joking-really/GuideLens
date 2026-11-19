#!/usr/bin/env node
import { runCli } from "./cli.js";
import { startStdioMcpServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length === 0 || (args.length === 1 && args[0] === "mcp")) {
  startStdioMcpServer().catch((err) => {
    process.stderr.write(
      `Failed to start GuideLens MCP server: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  });
} else {
  runCli(args).then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
