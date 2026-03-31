# Oncrawl MCP Pi Extension

A [Pi Agent](https://github.com/mariozechner/pi-coding-agent) extension that bridges the [Oncrawl MCP Server](https://github.com/Amaculus/oncrawl-mcp-server) directly into Pi – no Claude Code or Claude Desktop required.

## What it does

Pi Agent has no native MCP client. This extension fills that gap:

1. **Spawns** the Oncrawl Python MCP server as a subprocess on session start
2. **Implements** the MCP stdio protocol (newline-delimited JSON-RPC 2.0) in TypeScript
3. **Auto-discovers** all tools exposed by the server and registers them as native Pi tools
4. **Cleans up** the subprocess on session shutdown

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

- [Pi Agent](https://github.com/mariozechner/pi-coding-agent) installed
- Python 3.11+ with the [oncrawl-mcp-server](https://github.com/Amaculus/oncrawl-mcp-server) installed in a venv
- An Oncrawl account with API access (`project:read` scope is sufficient)

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

```bash
cp config.example.ts config.ts
```

Edit `config.ts`:

```ts
export const PYTHON_BIN = "/Users/yourname/oncrawl-mcp-server/.venv/bin/python";
export const MODULE = "oncrawl_mcp_server.server";
export const ONCRAWL_API_TOKEN = "your-token-here";
export const ONCRAWL_WORKSPACE_ID = "your-workspace-id-here";
```

**Find your Workspace ID** in the Oncrawl URL:
`https://app.oncrawl.com/workspace/`**`<ID>`**`/projects`

**Get your API token** at Oncrawl → Settings → API

### 3. Install the extension into Pi

```bash
mkdir -p ~/.pi/agent/extensions/oncrawl-mcp
cp index.ts config.ts ~/.pi/agent/extensions/oncrawl-mcp/
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

The MCP stdio protocol used by this server is **newline-delimited JSON-RPC 2.0** (not the Content-Length framing described in some MCP specs). Each message is a single JSON object terminated by `\n`.

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
├── config.ts         # Your credentials (git-ignored)
├── config.example.ts # Template – commit this, not config.ts
└── README.md
```

## Credits

- [Oncrawl MCP Server](https://github.com/Amaculus/oncrawl-mcp-server) by Antonio (Amaculus)
- [Pi Agent](https://github.com/mariozechner/pi-coding-agent) by Mario Zechner
