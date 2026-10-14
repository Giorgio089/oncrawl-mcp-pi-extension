/**
 * Oncrawl MCP Extension for Pi Agent
 *
 * Spawns the Oncrawl MCP Server as a subprocess, communicates via
 * newline-delimited JSON-RPC 2.0 over stdio, and registers every
 * discovered tool as a native Pi custom tool.
 *
 * Setup: configure via environment variables (see below and README).
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
// ─── Configuration via Environment Variables ────────────────────────────────
// Set these in your shell profile (~/.zshrc, ~/.bashrc, etc.)
//
//   export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
//   export ONCRAWL_API_TOKEN="your-token"
//   export ONCRAWL_WORKSPACE_ID="your-workspace-id"  # optional
//   export ONCRAWL_MODULE="oncrawl_mcp_server.server"  # optional, this is the default
//   export ONCRAWL_TIMEOUT_MS="120000"       # optional, per-call timeout
//   export ONCRAWL_LONG_TIMEOUT_MS="600000"  # optional, timeout for export / auto-paginating tools

const PYTHON_BIN = process.env.ONCRAWL_PYTHON_BIN ?? "";
const MODULE = process.env.ONCRAWL_MODULE ?? "oncrawl_mcp_server.server";
const ONCRAWL_API_TOKEN = process.env.ONCRAWL_API_TOKEN ?? "";
const ONCRAWL_WORKSPACE_ID = process.env.ONCRAWL_WORKSPACE_ID ?? "";

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TIMEOUT_MS = envMs("ONCRAWL_TIMEOUT_MS", 120_000);
// Exports and auto-paginating searches can run for minutes (upstream export
// itself allows 300 s per HTTP request), so they get a longer budget.
const LONG_TIMEOUT_MS = envMs("ONCRAWL_LONG_TIMEOUT_MS", 600_000);
const LONG_RUNNING_TOOL = /^oncrawl_(export_|search_all_)/;

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

  private request(
    method: string,
    params?: unknown,
    timeoutMs: number = TIMEOUT_MS
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error("MCP server not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(
            new Error(
              `MCP request timeout after ${Math.round(timeoutMs / 1000)} s: ${method}`
            )
          );
        }
      }, timeoutMs);
      timer.unref();

      this.pendingRequests.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sendLine({ jsonrpc: "2.0", id, method, params });
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
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      LONG_RUNNING_TOOL.test(name) ? LONG_TIMEOUT_MS : TIMEOUT_MS
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    const text = (result?.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");

    // The upstream server reports failures as plain text ("Error: …",
    // "Unknown tool: …") without isError, so check both. Throwing makes Pi
    // mark the tool call as failed.
    if (result?.isError || /^(Error:|Unknown tool:)/.test(text)) {
      throw new Error(text || `Oncrawl tool ${name} failed`);
    }
    return text;
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

// ─── Output Truncation ────────────────────────────────────────────────────────
// Pi requires tools to keep output within DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES.
// The full result is saved to a temp file so the model can read it on demand.

function truncateOutput(toolName: string, output: string): string {
  if (Buffer.byteLength(output) <= DEFAULT_MAX_BYTES) return output;

  // Upstream returns compact single-line JSON; pretty-print it so it can be
  // cut at line boundaries instead of being dropped entirely.
  let full = output;
  let isJson = false;
  try {
    full = JSON.stringify(JSON.parse(output), null, 1);
    isJson = true;
  } catch {
    // not JSON – keep as is
  }

  const dir = join(tmpdir(), "oncrawl-mcp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${toolName}-${Date.now()}.${isJson ? "json" : "txt"}`);
  writeFileSync(file, full);

  const t = truncateHead(full, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const head = t.firstLineExceedsLimit
    ? full.slice(0, DEFAULT_MAX_BYTES)
    : t.content;

  return (
    `${head}\n\n[Output truncated: showing ${formatSize(Buffer.byteLength(head))} ` +
    `of ${formatSize(t.totalBytes)} (${t.totalLines} lines). ` +
    `Full output saved to: ${file} – read or query it (e.g. with jq) for the rest, ` +
    `or narrow the request with OQL filters, fewer fields or a lower limit.]`
  );
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
          description:
            (tool.description ?? tool.name) +
            `\n\nOutput over ${formatSize(DEFAULT_MAX_BYTES)} is truncated; the full result is saved to a temp file whose path is included in the output.`,
          parameters: schema,

          async execute(_toolCallId, params, _signal, onUpdate) {
            onUpdate?.({
              content: [{ type: "text", text: `⏳ Oncrawl API call running (${tool.name})…` }],
              details: { tool: tool.name },
            });

            const args = params as Record<string, unknown>;
            const cleanArgs = Object.fromEntries(
              Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
            );

            const result = await client.callTool(tool.name, cleanArgs);
            return {
              content: [{ type: "text", text: truncateOutput(tool.name, result) }],
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
