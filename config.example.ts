/**
 * config.example.ts
 *
 * Copy this file to config.ts and fill in your credentials.
 * config.ts is git-ignored and will never be committed.
 */

// Absolute path to the Python binary inside your venv
// Example: /Users/yourname/oncrawl-mcp-server/.venv/bin/python
export const PYTHON_BIN = "/path/to/oncrawl-mcp-server/.venv/bin/python";

// Python module to run
export const MODULE = "oncrawl_mcp_server.server";

// Your Oncrawl API token (Settings → API in the Oncrawl dashboard)
export const ONCRAWL_API_TOKEN = "YOUR_API_TOKEN_HERE";

// Your Oncrawl Workspace ID
// Find it in the URL: https://app.oncrawl.com/workspace/<WORKSPACE_ID>/projects
export const ONCRAWL_WORKSPACE_ID = "YOUR_WORKSPACE_ID_HERE";
