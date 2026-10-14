# Oncrawl MCP Pi Extension

A [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that bridges the [Oncrawl MCP Server](https://github.com/Amaculus/oncrawl-mcp-server) directly into Pi – no Claude Code / Desktop required.

## Installation

### Via Pi (recommended)

```bash
pi install npm:oncrawl-mcp-pi-extension
```

Then set the required environment variables in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export ONCRAWL_PYTHON_BIN="/Users/yourname/oncrawl-mcp-server/.venv/bin/python"
export ONCRAWL_API_TOKEN="your-token-here"
export ONCRAWL_WORKSPACE_ID="your-workspace-id"   # optional
```

Optional tuning:

```bash
export ONCRAWL_TIMEOUT_MS="120000"        # per-call timeout (default 120 s)
export ONCRAWL_LONG_TIMEOUT_MS="600000"   # oncrawl_export_* / oncrawl_search_all_* (default 600 s)
```

Restart your shell (or `source ~/.zshrc`), then start Pi. That's it.

### Manual installation

See the [manual setup](#setup) section below.

---

## What it does

Pi Agent has no native MCP client. This extension fills that gap:

1. **Spawns** the Oncrawl Python MCP server as a subprocess on session start
2. **Implements** the MCP stdio protocol (newline-delimited JSON-RPC 2.0) in TypeScript
3. **Auto-discovers** all tools exposed by the server and registers them as native Pi tools
4. **Truncates** large results to Pi's output limit (50 KB / 2000 lines) and saves the full result to a temp file (`$TMPDIR/oncrawl-mcp/`), whose path is shown to the model
5. **Reports errors** from the Oncrawl API as failed tool calls, so the model sees them as errors
6. **Cleans up** the subprocess on session shutdown

All **21 Oncrawl tools** become available directly in Pi, including:

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

## Requirements

- [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) installed
- Python 3.11+ with the [oncrawl-mcp-server](https://github.com/Amaculus/oncrawl-mcp-server) installed in a venv
- An Oncrawl account with API access (`projects:read` scope is sufficient)

## Setup

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

The MCP stdio transport uses **newline-delimited JSON-RPC 2.0** (not the Content-Length framing known from LSP). Each message is a single JSON object terminated by `\n`.

The handshake sequence:
1. Send `initialize` → receive server capabilities
2. Send `notifications/initialized` (no response)
3. Send `tools/list` → receive all tool definitions
4. For each tool call: send `tools/call` → receive result

TypeBox schemas are built dynamically from each tool's `inputSchema`, so new tools added upstream are picked up automatically without any changes to this extension.

## File structure

```
oncrawl-mcp-pi-extension/
├── index.ts          # Extension entry point (Pi loads this)
├── package.json
└── README.md
```

## Credits

- [Oncrawl MCP Server](https://github.com/Amaculus/oncrawl-mcp-server) by Antonio (Amaculus)
- [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) by Mario Zechner
