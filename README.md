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

## Tools (40)

### Features
| Tool | Description |
|---|---|
| `pb_features_list` | List features with optional filters and pagination |
| `pb_feature_get` | Get feature details by ID |
| `pb_feature_create` | Create a feature |
| `pb_feature_update` | Update a feature by ID |
| `pb_feature_delete` | Delete a feature by ID |
| `pb_feature_statuses` | List available feature statuses |
| `pb_feature_objectives` | List objectives linked to a feature |
| `pb_feature_link_objective` | Link a feature to an objective |
| `pb_feature_link_initiative` | Link a feature to an initiative |
| `pb_feature_release_list` | List feature-release assignments |
| `pb_feature_release_assign` | Assign or unassign a feature to a release |

### Notes (Customer Feedback)
| Tool | Description |
|---|---|
| `pb_notes_list` | List notes with optional filters and pagination |
| `pb_note_get` | Get note details by ID |
| `pb_note_create` | Create a note |
| `pb_note_update` | Update a note by ID |
| `pb_note_link` | Link a note to an entity (feature, company, etc.) |

### Objectives & Key Results
| Tool | Description |
|---|---|
| `pb_objectives_list` | List objectives with optional filters |
| `pb_objective_get` | Get objective details by ID |
| `pb_objective_create` | Create an objective |
| `pb_objective_update` | Update an objective by ID |
| `pb_key_results_list` | List key results with optional filters |
| `pb_key_result_get` | Get key result details by ID |
| `pb_key_result_create` | Create a key result |
| `pb_key_result_update` | Update a key result by ID |

### Initiatives
| Tool | Description |
|---|---|
| `pb_initiatives_list` | List initiatives with optional filters |
| `pb_initiative_get` | Get initiative details by ID |
| `pb_initiative_create` | Create an initiative |
| `pb_initiative_update` | Update an initiative by ID |

### Releases
| Tool | Description |
|---|---|
| `pb_releases_list` | List releases |
| `pb_release_get` | Get release details by ID |
| `pb_release_create` | Create a release |
| `pb_release_update` | Update a release by ID |
| `pb_release_groups_list` | List release groups |

### Organization
| Tool | Description |
|---|---|
| `pb_products_list` | List products |
| `pb_components_list` | List components |
| `pb_companies_list` | List companies |
| `pb_users_list` | List users |
| `pb_custom_fields_list` | List custom fields for hierarchy entities |
| `pb_custom_field_value_get` | Get custom field value for a hierarchy entity |
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
