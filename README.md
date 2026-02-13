# Productboard Connector for Claude Desktop

A one-click [MCP Bundle](https://github.com/modelcontextprotocol/mcpb) (.mcpb) that connects Claude Desktop to [Productboard](https://www.productboard.com). Browse features, customer feedback, releases, and more — directly from Claude.

## Install

1. [Download the latest `.mcpb`](https://github.com/benmillerat/productboard-mcpb/releases) (or build it yourself — see below)
2. Double-click the file — Claude Desktop opens the install dialog
3. Enter your Productboard API token when prompted
4. Done! Ask Claude about your Productboard data

> No Terminal, no Node.js install, no config files. The token is stored securely in your macOS/Windows keychain.

## Get Your API Token

1. Log into [productboard.com](https://productboard.com)
2. Click your profile picture → **Integrations** → **Public API**
3. Click **+ Add Token** and copy it

Requires Productboard Pro plan or higher.

## Tools

| Tool | Description |
|---|---|
| `pb_features_list` | List and filter features |
| `pb_feature_get` | Get feature details |
| `pb_feature_create` | Create a feature |
| `pb_feature_update` | Update a feature |
| `pb_notes_list` | List customer feedback notes |
| `pb_note_create` | Create a feedback note |
| `pb_products_list` | List products and components |
| `pb_releases_list` | List releases |
| `pb_release_get` | Get release details |
| `pb_companies_list` | List companies |
| `pb_user_current` | Verify API connection |

## Build from Source

```bash
git clone https://github.com/benmillerat/productboard-mcpb.git
cd productboard-mcpb
npm install --production
npm install -g @anthropic-ai/mcpb
mcpb pack . productboard-connector.mcpb
```

## Manual Setup (without .mcpb)

If you prefer the traditional MCP config approach, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "productboard": {
      "command": "node",
      "args": ["path/to/productboard-mcpb/server/index.js"],
      "env": {
        "PRODUCTBOARD_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Privacy & Security

- Runs **locally** on your machine — no third-party servers
- API token stored in the OS keychain (when using .mcpb)
- All calls go directly from your machine to `api.productboard.com`
- No telemetry, no analytics

## License

MIT
