/**
 * Oncrawl MCP Extension for Pi Agent
 *
 * Spawns the Oncrawl MCP Server as a subprocess, communicates via
 * newline-delimited JSON-RPC 2.0 over stdio, and registers every
 * discovered tool as a native Pi custom tool.
 *
 * Setup: copy config.example.ts → config.ts and fill in your credentials.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
// ─── Configuration via Environment Variables ────────────────────────────────
// Set these in your shell profile (~/.zshrc, ~/.bashrc, etc.)
//
//   export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
//   export ONCRAWL_API_TOKEN="your-token"
//   export ONCRAWL_WORKSPACE_ID="your-workspace-id"  # optional
//   export ONCRAWL_MODULE="oncrawl_mcp_server.server"  # optional, this is the default

const PYTHON_BIN = process.env.ONCRAWL_PYTHON_BIN ?? "";
const MODULE = process.env.ONCRAWL_MODULE ?? "oncrawl_mcp_server.server";
const ONCRAWL_API_TOKEN = process.env.ONCRAWL_API_TOKEN ?? "";
const ONCRAWL_WORKSPACE_ID = process.env.ONCRAWL_WORKSPACE_ID ?? "";

// ─── MCP Client (newline-delimited JSON-RPC over stdio) ──────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    enum?: string[];
  };
}

class McpStdioClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(PYTHON_BIN, ["-m", MODULE], {
        env: {
          ...process.env,
          ONCRAWL_API_TOKEN,
          ONCRAWL_WORKSPACE_ID,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // stderr: suppress MCP server INFO/ERROR logs
      this.proc.stderr.on("data", () => {});

      // Parse newline-delimited JSON from stdout
      const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id !== undefined) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(
                  new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
                );
              } else {
                pending.resolve(msg.result);
              }
            }
          }
          // notifications (no id) are silently ignored
        } catch {
          // ignore parse errors
        }
      });

      this.proc.on("error", (err) => {
        reject(new Error(`Failed to start MCP server: ${err.message}`));
      });

      this.proc.on("exit", (code) => {
        for (const [, { reject: rej }] of this.pendingRequests) {
          rej(new Error(`MCP server exited with code ${code}`));
        }
        this.pendingRequests.clear();
      });

      // Give the server a moment to boot, then run the MCP handshake
      setTimeout(async () => {
        try {
          await this.initialize();
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 600);
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private sendLine(obj: unknown): void {
    if (!this.proc) throw new Error("MCP server not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error("MCP server not running"));
        return;
      }
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.sendLine({ jsonrpc: "2.0", id, method, params });

      // 120 s timeout – large Oncrawl exports can be slow
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "pi-agent", version: "1.0.0" },
    });
    // Notification: no response expected
    this.sendLine({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list")) as { tools: McpTool[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }> };

    return (result?.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
}

// ─── TypeBox Schema Builder ───────────────────────────────────────────────────

function buildTypeBoxSchema(inputSchema: McpTool["inputSchema"]) {
  const props: Record<string, unknown> = {};
  const required: string[] = inputSchema.required ?? [];

  for (const [key, def] of Object.entries(inputSchema.properties ?? {})) {
    const d = def as Record<string, unknown>;
    const isRequired = required.includes(key);

    let schema: unknown;

    if (d.enum && Array.isArray(d.enum)) {
      schema = Type.String({
        description: `${d.description ?? ""} (Allowed values: ${d.enum.join(", ")})`,
        ...(d.default !== undefined ? { default: d.default } : {}),
      });
    } else {
      switch (d.type) {
        case "integer":
        case "number":
          schema = Type.Number({
            description: (d.description as string) ?? "",
            ...(d.default !== undefined ? { default: d.default } : {}),
          });
          break;
        case "boolean":
          schema = Type.Boolean({
            description: (d.description as string) ?? "",
            ...(d.default !== undefined ? { default: d.default } : {}),
          });
          break;
        case "array":
          schema = Type.Array(Type.Unknown(), {
            description: (d.description as string) ?? "",
          });
          break;
        case "object":
          schema = Type.Record(Type.String(), Type.Unknown(), {
            description: (d.description as string) ?? "",
          });
          break;
        default:
          schema = Type.String({
            description: (d.description as string) ?? "",
            ...(d.default !== undefined ? { default: d.default } : {}),
          });
      }
    }

    props[key] = isRequired ? schema : Type.Optional(schema as never);
  }

  return Type.Object(props as never);
}

function toolLabel(name: string): string {
  return name
    .replace(/^oncrawl_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const client = new McpStdioClient();
  let initialized = false;

  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;

    // Validate required env vars
    const missing: string[] = [];
    if (!PYTHON_BIN) missing.push("ONCRAWL_PYTHON_BIN");
    if (!ONCRAWL_API_TOKEN) missing.push("ONCRAWL_API_TOKEN");
    if (missing.length > 0) {
      ctx.ui.notify(
        `Oncrawl MCP: Missing required environment variable(s): ${missing.join(", ")}. See https://github.com/Giorgio089/oncrawl-mcp-pi-extension for setup instructions.`,
        "error"
      );
      return;
    }

    ctx.ui.setStatus("oncrawl", "🔄 Oncrawl MCP starting…");

    try {
      await client.start();
      const tools = await client.listTools();

      for (const tool of tools) {
        const schema = buildTypeBoxSchema(tool.inputSchema);

        pi.registerTool({
          name: tool.name,
          label: `Oncrawl: ${toolLabel(tool.name)}`,
          description: tool.description ?? tool.name,
          parameters: schema,

          async execute(_toolCallId, params, _signal, onUpdate) {
            onUpdate?.({
              content: [{ type: "text", text: `⏳ Oncrawl API call running (${tool.name})…` }],
            });

            const args = params as Record<string, unknown>;
            const cleanArgs = Object.fromEntries(
              Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
            );

            const result = await client.callTool(tool.name, cleanArgs);
            return {
              content: [{ type: "text", text: result }],
              details: { tool: tool.name, args: cleanArgs },
            };
          },
        });
      }

      initialized = true;
      ctx.ui.setStatus("oncrawl", `✅ Oncrawl ready – ${tools.length} tools`);
      setTimeout(() => ctx.ui.setStatus("oncrawl", ""), 5000);
      ctx.ui.notify(`Oncrawl MCP loaded: ${tools.length} tools available`, "info");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.setStatus("oncrawl", "");
      ctx.ui.notify(`Oncrawl MCP error: ${msg}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    client.stop();
  });
}
