/**
 * Oncrawl MCP Extension for Pi Agent
 *
 * Connects Pi to an Oncrawl MCP server and registers every discovered tool
 * as a native Pi custom tool. Two backends are supported:
 *
 *   - stdio (default): spawns the Python oncrawl-mcp-server (Amaculus) as a
 *     subprocess and talks newline-delimited JSON-RPC 2.0 over stdio.
 *   - http: connects to Oncrawl's official MCP server via Streamable HTTP,
 *     authenticated with an Oncrawl API token sent as request headers.
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
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
// ─── Configuration via Environment Variables ────────────────────────────────
// Set these in your shell profile (~/.zshrc, ~/.bashrc, etc.)
//
//   export ONCRAWL_API_TOKEN="your-token"            # required for both backends
//
// stdio backend (Python oncrawl-mcp-server, default):
//   export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
//   export ONCRAWL_WORKSPACE_ID="your-workspace-id"  # optional
//   export ONCRAWL_MODULE="oncrawl_mcp_server.server"  # optional, this is the default
//
// http backend (official Oncrawl MCP server) – enabled by setting the URL:
//   export ONCRAWL_MCP_URL="https://mcp.oncrawl.com/mcp"
//   export ONCRAWL_API_URL="https://app.oncrawl.com/"  # optional, this is the default
//   export ONCRAWL_WRITE_MODE="confirm"   # optional: confirm (default) | allow | deny
//
// Both:
//   export ONCRAWL_TIMEOUT_MS="120000"       # optional, per-call timeout
//   export ONCRAWL_LONG_TIMEOUT_MS="600000"  # optional, timeout for export / auto-paginating tools

const PYTHON_BIN = process.env.ONCRAWL_PYTHON_BIN ?? "";
const MODULE = process.env.ONCRAWL_MODULE ?? "oncrawl_mcp_server.server";
const ONCRAWL_API_TOKEN = process.env.ONCRAWL_API_TOKEN ?? "";
const ONCRAWL_WORKSPACE_ID = process.env.ONCRAWL_WORKSPACE_ID ?? "";
const MCP_URL = process.env.ONCRAWL_MCP_URL ?? "";
const API_URL = process.env.ONCRAWL_API_URL || "https://app.oncrawl.com/";
const WRITE_MODE = (process.env.ONCRAWL_WRITE_MODE ?? "confirm").toLowerCase();

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TIMEOUT_MS = envMs("ONCRAWL_TIMEOUT_MS", 120_000);
// Exports and auto-paginating searches can run for minutes (upstream export
// itself allows 300 s per HTTP request), so they get a longer budget.
const LONG_TIMEOUT_MS = envMs("ONCRAWL_LONG_TIMEOUT_MS", 600_000);
const LONG_RUNNING_TOOL = /^oncrawl_(export_|search_all_)/;

// Operation values of the official server's *_operations tools that change
// data in Oncrawl (create projects, launch crawls, delete …).
const WRITE_OPERATIONS = new Set(["create", "update", "delete", "run", "stop", "command"]);

// ─── MCP Transports ───────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
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

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface McpTransport {
  /** Protocol version offered in `initialize`. */
  readonly protocolVersion: string;
  start(): Promise<void>;
  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  /** Called once `initialize` succeeded, with the negotiated protocol version. */
  onInitialized?(protocolVersion: string): void;
  stop(): void;
}

function rpcError(msg: JsonRpcMessage): Error {
  return new Error(`MCP error ${msg.error!.code}: ${msg.error!.message}`);
}

// ─── stdio transport (Python oncrawl-mcp-server) ─────────────────────────────

class StdioTransport implements McpTransport {
  readonly protocolVersion = "2024-11-05";
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private stderrTail: string[] = [];

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(PYTHON_BIN, ["-m", MODULE], {
        env: {
          ...process.env,
          ONCRAWL_API_TOKEN,
          ONCRAWL_WORKSPACE_ID,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      // Keep the last stderr lines (not shown) to explain startup failures
      createInterface({ input: proc.stderr }).on("line", (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      });

      // Parse newline-delimited JSON from stdout
      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (typeof msg.id === "number") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              if (msg.error) pending.reject(rpcError(msg));
              else pending.resolve(msg.result);
            }
          }
          // notifications (no id) are silently ignored
        } catch {
          // ignore parse errors
        }
      });

      // Writing to a dead server must not crash Pi; the exit handler reports it
      proc.stdin.on("error", () => {});

      proc.on("error", (err) => {
        this.proc = null;
        reject(new Error(`Failed to start MCP server: ${err.message}`));
      });

      proc.on("exit", (code) => {
        this.proc = null;
        const tail = this.stderrTail.slice(-5).join("\n");
        const err = new Error(
          `MCP server exited with code ${code}` + (tail ? `\n${tail}` : "")
        );
        for (const [, { reject: rej }] of this.pendingRequests) rej(err);
        this.pendingRequests.clear();
      });

      // stdin is buffered, so the handshake can be sent right away
      proc.once("spawn", () => resolve());
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

  async notify(method: string, params?: unknown): Promise<void> {
    this.sendLine({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error("MCP server not running"));
        return;
      }
      const id = this.nextId++;
      const fail = (e: Error) => {
        if (this.pendingRequests.delete(id)) {
          cleanup();
          reject(e);
        }
      };
      const timer = setTimeout(
        () => fail(new Error(`MCP request timeout after ${Math.round(timeoutMs / 1000)} s: ${method}`)),
        timeoutMs
      );
      timer.unref();
      const onAbort = () => {
        fail(new Error("Oncrawl request cancelled"));
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => {});
      };
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      if (opts.signal?.aborted) {
        reject(new Error("Oncrawl request cancelled"));
        clearTimeout(timer);
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingRequests.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      this.sendLine({ jsonrpc: "2.0", id, method, params });
    });
  }
}

// ─── Streamable HTTP transport (official Oncrawl MCP server) ─────────────────

class HttpTransport implements McpTransport {
  readonly protocolVersion = "2025-06-18";
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;
  private nextId = 1;

  constructor(
    private url: string,
    private headers: Record<string, string>
  ) {}

  async start(): Promise<void> {}

  onInitialized(protocolVersion: string): void {
    this.negotiatedVersion = protocolVersion;
  }

  stop(): void {
    // Politely end the server-side session; failures don't matter here.
    if (this.sessionId) {
      fetch(this.url, {
        method: "DELETE",
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      this.sessionId = null;
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.negotiatedVersion ? { "MCP-Protocol-Version": this.negotiatedVersion } : {}),
    };
  }

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok && res.status !== 202) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      const hint =
        res.status === 401 || res.status === 403
          ? " – check ONCRAWL_API_TOKEN (and that your plan includes the Oncrawl API option)"
          : "";
      throw new Error(`Oncrawl MCP HTTP ${res.status}${hint}${text ? `: ${text}` : ""}`);
    }
    return res;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, params }, AbortSignal.timeout(TIMEOUT_MS));
    await res.body?.cancel().catch(() => {});
  }

  async request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const id = this.nextId++;

    try {
      const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      const type = res.headers.get("content-type") ?? "";
      const msg = type.includes("text/event-stream")
        ? await this.readSse(res, id)
        : this.pick(await res.json(), id);
      if (!msg) throw new Error(`Oncrawl MCP: no response for ${method}`);
      if (msg.error) throw rpcError(msg);
      return msg.result;
    } catch (err) {
      if (timeout.aborted) {
        throw new Error(`MCP request timeout after ${Math.round(timeoutMs / 1000)} s: ${method}`);
      }
      if (opts.signal?.aborted) {
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => {});
        throw new Error("Oncrawl request cancelled");
      }
      throw err;
    }
  }

  private pick(data: unknown, id: number): JsonRpcMessage | undefined {
    const msgs = (Array.isArray(data) ? data : [data]) as JsonRpcMessage[];
    return msgs.find((m) => m && m.id === id);
  }

  /** Read an SSE stream until the JSON-RPC response with `id` arrives. */
  private async readSse(res: Response, id: number): Promise<JsonRpcMessage | undefined> {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) buffer += value.replace(/\r\n?/g, "\n");
        // Events are separated by a blank line
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = event
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          try {
            const msg = this.pick(JSON.parse(data), id);
            if (msg) return msg;
          } catch {
            // ignore non-JSON events
          }
        }
        if (done) return undefined;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

// ─── MCP Client ───────────────────────────────────────────────────────────────

class McpClient {
  constructor(private transport: McpTransport) {}

  async start(): Promise<void> {
    await this.transport.start();
    const result = (await this.transport.request(
      "initialize",
      {
        protocolVersion: this.transport.protocolVersion,
        capabilities: {},
        clientInfo: { name: "pi-agent", version: "1.0.0" },
      },
      {}
    )) as { protocolVersion?: string };
    this.transport.onInitialized?.(result?.protocolVersion ?? this.transport.protocolVersion);
    // Notification: no response expected
    await this.transport.notify("notifications/initialized");
  }

  stop(): void {
    this.transport.stop();
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.transport.request(
        "tools/list",
        cursor ? { cursor } : undefined,
        {}
      )) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    const result = (await this.transport.request(
      "tools/call",
      { name, arguments: args },
      { timeoutMs: LONG_RUNNING_TOOL.test(name) ? LONG_TIMEOUT_MS : TIMEOUT_MS, signal }
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

/**
 * Name of the parameter that selects a write operation (e.g. `operation` on
 * `project_operations`), found by looking for an enum containing one.
 */
function findOperationParam(inputSchema: McpTool["inputSchema"]): string | undefined {
  for (const [key, def] of Object.entries(inputSchema.properties ?? {})) {
    const values = (def as { enum?: unknown[] }).enum;
    if (values?.some((v) => typeof v === "string" && WRITE_OPERATIONS.has(v))) return key;
  }
  return undefined;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const useHttp = MCP_URL !== "";
  const client = new McpClient(
    useHttp
      ? new HttpTransport(MCP_URL, { "api-key": ONCRAWL_API_TOKEN, "api-url": API_URL })
      : new StdioTransport()
  );
  let initialized = false;

  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;

    // Validate required env vars
    const missing: string[] = [];
    if (!useHttp && !PYTHON_BIN) missing.push("ONCRAWL_PYTHON_BIN");
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
        // The official server uses generic names (project_operations, …);
        // prefix them so they are recognisable among Pi's other tools.
        const name = tool.name.startsWith("oncrawl_") ? tool.name : `oncrawl_${tool.name}`;
        // The Python server's flat schemas are converted as before; the
        // official server's schemas (nested objects, unions) are passed
        // through unchanged so the model sees their exact shape.
        const schema = useHttp
          ? Type.Unsafe<Record<string, unknown>>(tool.inputSchema)
          : buildTypeBoxSchema(tool.inputSchema);
        const operationParam = useHttp ? findOperationParam(tool.inputSchema) : undefined;

        pi.registerTool({
          name,
          label: `Oncrawl: ${toolLabel(name)}`,
          description:
            (tool.description ?? tool.name) +
            `\n\nOutput over ${formatSize(DEFAULT_MAX_BYTES)} is truncated; the full result is saved to a temp file whose path is included in the output.`,
          parameters: schema,

          async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const args = params as Record<string, unknown>;
            const cleanArgs = Object.fromEntries(
              Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
            );

            const operation = operationParam ? cleanArgs[operationParam] : undefined;
            if (typeof operation === "string" && WRITE_OPERATIONS.has(operation)) {
              const what = `${tool.name} → ${operation}`;
              if (WRITE_MODE === "deny") {
                throw new Error(`Blocked write operation ${what} (ONCRAWL_WRITE_MODE=deny).`);
              }
              if (WRITE_MODE !== "allow") {
                if (!ctx.hasUI) {
                  throw new Error(
                    `Blocked write operation ${what}: no UI to confirm. Set ONCRAWL_WRITE_MODE=allow to permit it.`
                  );
                }
                const ok = await ctx.ui.confirm(
                  "Oncrawl write operation",
                  `${what}\n\n${JSON.stringify(cleanArgs, null, 2)}`
                );
                if (!ok) throw new Error(`User declined write operation ${what}.`);
              }
            }

            onUpdate?.({
              content: [{ type: "text", text: `⏳ Oncrawl API call running (${tool.name})…` }],
              details: { tool: tool.name },
            });

            const result = await client.callTool(tool.name, cleanArgs, signal);
            return {
              content: [{ type: "text", text: truncateOutput(name, result) }],
              details: { tool: tool.name, args: cleanArgs },
            };
          },
        });
      }

      initialized = true;
      const backend = useHttp ? "official server" : "local server";
      ctx.ui.setStatus("oncrawl", `✅ Oncrawl ready – ${tools.length} tools`);
      setTimeout(() => ctx.ui.setStatus("oncrawl", ""), 5000);
      ctx.ui.notify(`Oncrawl MCP loaded (${backend}): ${tools.length} tools available`, "info");
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
