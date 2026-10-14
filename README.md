# Oncrawl MCP Pi Extension

A [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that brings Oncrawl into Pi via MCP – no Claude Code / Desktop required.

It supports two backends, both authenticated with your **Oncrawl API token**:

| Backend | Server | Best for |
|---|---|---|
| **stdio** (default) | Local Python [oncrawl-mcp-server](https://github.com/Amaculus/oncrawl-mcp-server) by Amaculus | Bulk data: up to 10k rows per search, auto-pagination, full exports |
| **http** | [Official Oncrawl MCP server](https://help.oncrawl.com/en/articles/14196013-introduction-to-the-oncrawl-mcp-server) (`https://mcp.oncrawl.com/mcp`) | No Python needed; adds log data, URL details, rankings, segmentations, crawl management (max 20 rows per search) |

## Installation

### Via Pi (recommended)

```bash
pi install npm:oncrawl-mcp-pi-extension
```

Then set the environment variables in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.).

**stdio backend** (local Python server, default):

```bash
export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
export ONCRAWL_API_TOKEN="your-token-here"
export ONCRAWL_WORKSPACE_ID="your-workspace-id"   # optional
```

**http backend** (official Oncrawl MCP server) – setting `ONCRAWL_MCP_URL` switches to it:

```bash
export ONCRAWL_MCP_URL="https://mcp.oncrawl.com/mcp"
export ONCRAWL_API_TOKEN="your-token-here"
export ONCRAWL_API_URL="https://app.oncrawl.com/"   # optional, this is the default
```

The token is sent as the `api-key` header together with `api-url`, as described in Oncrawl's [token-based authentication](https://help.oncrawl.com/en/articles/14196013-introduction-to-the-oncrawl-mcp-server). Using a token requires the Oncrawl API option in your subscription.

Optional tuning:

```bash
export ONCRAWL_TIMEOUT_MS="120000"        # per-call timeout (default 120 s)
export ONCRAWL_LONG_TIMEOUT_MS="600000"   # oncrawl_export_* / oncrawl_search_all_* (default 600 s)
export ONCRAWL_WRITE_MODE="confirm"       # http backend: confirm (default) | allow | deny
```

### Write operations (http backend)

The official server can also create, update, delete and launch things (projects, crawl configs, crawls, scheduled crawls, exports, secrets). Whenever a tool is called with such an operation (`create`, `update`, `delete`, `run`, `stop`, `command`), the extension asks for confirmation first (`ONCRAWL_WRITE_MODE=confirm`, the default). In print/JSON mode, where Pi can't ask, these calls are blocked unless you set `ONCRAWL_WRITE_MODE=allow`. `deny` blocks them always.

For pure analysis, the safest option is a token with **read permissions only**.

Restart your shell (or `source ~/.zshrc`), then start Pi. That's it.

### Manual installation

See the [manual setup](#setup) section below.

---

## What it does

Pi Agent has no native MCP client. This extension fills that gap:

1. **Connects** on session start – either by spawning the Python MCP server (stdio) or via Streamable HTTP to the official server
2. **Implements** the MCP client side (JSON-RPC 2.0 over stdio or HTTP/SSE) in TypeScript, without extra dependencies
3. **Auto-discovers** all tools exposed by the server and registers them as native Pi tools (the official server's tools get an `oncrawl_` prefix, e.g. `oncrawl_project_operations`)
4. **Truncates** large results to Pi's output limit (50 KB / 2000 lines) and saves the full result to a temp file (`$TMPDIR/oncrawl-mcp/`), whose path is shown to the model
5. **Reports errors** from the Oncrawl API as failed tool calls, so the model sees them as errors
6. **Cancels** running requests when you abort in Pi (Esc)
7. **Cleans up** the subprocess / HTTP session on session shutdown

With the **stdio backend**, all **21 tools** of the Python server become available, including:

| Tool | Purpose |
|------|---------|
| `oncrawl_list_projects` | List all projects in a workspace |
| `oncrawl_get_project` | Project details + all crawl IDs |
| `oncrawl_get_schema` | Discover queryable fields (call first!) |
| `oncrawl_search_pages` | OQL-filtered page search |
| `oncrawl_aggregate` | Group/count by any dimension |
| `oncrawl_site_health` | Site health overview |
| `oncrawl_top_issues` | Top SEO issues |
| `oncrawl_search_coc` | Crawl-over-crawl diff |
| `oncrawl_export_pages` | Full export, no 10k limit |
| … | + 12 more |

With the **http backend**, you get the tools of the [official server](https://help.oncrawl.com/en/articles/14211468-oncrawl-mcp-server-tools-reference), e.g. `oncrawl_get_context_user`, `oncrawl_get_data_search_crawl`, `oncrawl_get_data_aggregate_logs`, `oncrawl_url_details_operations`, `oncrawl_get_oql_documentation`.

## Requirements

- [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) installed
- An Oncrawl account with API access (`projects:read` scope is sufficient for analysis)
- stdio backend only: Python 3.11+ with the [oncrawl-mcp-server](https://github.com/Amaculus/oncrawl-mcp-server) installed in a venv

## Setup

(The http backend needs no setup beyond the environment variables above – skip to step 3.)

### 1. Install the Oncrawl MCP Server

```bash
git clone https://github.com/Amaculus/oncrawl-mcp-server.git ~/oncrawl-mcp-server
cd ~/oncrawl-mcp-server
python3.13 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 2. Configure credentials

Authentication uses an Oncrawl API token. Add these to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
export ONCRAWL_API_TOKEN="your-token-here"
export ONCRAWL_WORKSPACE_ID="your-workspace-id-here"    # optional
export ONCRAWL_MODULE="oncrawl_mcp_server.server"       # optional, this is the default
```

**Find your Workspace ID** in the Oncrawl URL:
`https://app.oncrawl.com/workspace/`**`<ID>`**`/projects`

**Get your API token** at Oncrawl → Settings → API

### 3. Install the extension into Pi

```bash
mkdir -p ~/.pi/agent/extensions/oncrawl-mcp
cp index.ts ~/.pi/agent/extensions/oncrawl-mcp/
```

### 4. Start Pi

The extension loads automatically on every session start. You'll see a status indicator in the footer:

```
🔄 Oncrawl MCP starting…
✅ Oncrawl ready – 21 tools
```

## Usage examples

```
"List my Oncrawl projects"

"Get the schema for crawl 69c9a0e4a42fd1f846e095cd"

"Find all pages with status 404 that still have internal links pointing to them"

"Show me pages with depth > 5 and fewer than 3 inlinks"

"What's the status code distribution for this crawl?"

"Find orphan pages that are getting clicks from Google"

"Show me what changed between the last two crawls"
```

## How it works

**stdio:** The MCP stdio transport uses **newline-delimited JSON-RPC 2.0** (not the Content-Length framing known from LSP). Each message is a single JSON object terminated by `\n`.

**http:** Requests are POSTed to `ONCRAWL_MCP_URL` ([Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)); responses arrive as JSON or as an SSE stream. The `Mcp-Session-Id` returned by `initialize` is sent with every later request, and the session is closed with `DELETE` on shutdown.

The handshake sequence (both backends):
1. Send `initialize` → receive server capabilities
2. Send `notifications/initialized` (no response)
3. Send `tools/list` → receive all tool definitions
4. For each tool call: send `tools/call` → receive result

Parameter schemas are built dynamically from each tool's `inputSchema` (passed through unchanged for the official server), so new tools added upstream are picked up automatically without any changes to this extension.

## File structure

```
oncrawl-mcp-pi-extension/
├── index.ts          # Extension entry point (Pi loads this)
├── package.json
└── README.md
```

## Releasing

New versions are published to npm by GitHub Actions (`.github/workflows/publish.yml`) using [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) – no npm token is stored in GitHub.

1. Bump `version` in `package.json` and merge to `main`.
2. Create a GitHub release with the tag `v<version>` (e.g. `v1.2.0`). The workflow refuses to publish if the tag and `package.json` disagree.

One-time setup on npmjs.com: package **Settings → Trusted Publisher → GitHub Actions** with owner `Giorgio089`, repository `oncrawl-mcp-pi-extension` and workflow `publish.yml`.

## Credits

- [Oncrawl MCP Server](https://github.com/Amaculus/oncrawl-mcp-server) by Antonio (Amaculus)
- [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) by Mario Zechner
