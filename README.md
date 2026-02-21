# OpenPAVE Google Drive Skill

A secure Google Drive CLI that works in the PAVE sandbox environment using secure token management.

## Features

- 📁 **List files and folders** with smart formatting
- 🔍 **Search files by name** across your Drive
- 📄 **Get file metadata** and sharing info
- 📖 **Read text files and Google Docs** directly
- ⬇️ **Download files** to local storage
- ⬆️ **Upload files** to Drive
- 📁 **Create folders** with parent support
- 💾 **Check storage quota** and usage

## Security

This skill uses the **PAVE secure token system**:
- 🔒 **OAuth tokens never visible** to sandbox code
- 🔄 **Automatic token refresh** handled by host
- 🛡️ **Permission-controlled network access**
- 🎯 **Domain-restricted API calls**

## Setup

1. **Configure token in `~/.pave/permissions.yaml`:**

```yaml
tokens:
  gdrive:
    env: GDRIVE_ACCESS_TOKEN
    type: oauth
    domains:
      - www.googleapis.com
      - "*.googleapis.com"
    placement:
      type: header
      name: Authorization
      format: "Bearer {token}"
      refreshEnv: GDRIVE_REFRESH_TOKEN
      refreshUrl: https://oauth2.googleapis.com/token
      clientIdEnv: GMAIL_CLIENT_ID
      clientSecretEnv: GMAIL_CLIENT_SECRET
```

2. **Set environment variables in `~/.pave/tokens.yaml` or `.env`:**

```bash
# Reuse Gmail OAuth credentials (from Google Cloud Console)
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret

# New Drive-specific refresh token
GDRIVE_REFRESH_TOKEN=your-gdrive-refresh-token

# Note: GDRIVE_ACCESS_TOKEN is NOT required!
# The system automatically obtains access tokens using the refresh token
```

3. **Grant necessary permissions:**

```bash
# Network access for Google APIs
pave-run --allow-network=*.googleapis.com

# File system access for uploads/downloads
pave-run --allow-write=tmp/*
```

## Usage

### List Files

```bash
# List files in root folder
node index.js ls --summary

# List files in specific folder
node index.js ls 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms --summary

# List with custom ordering
node index.js ls --order "name" --summary
```

### Search Files

```bash
# Search by filename
node index.js search "project proposal" --summary

# Limit results
node index.js search "invoice" --max 10 --summary
```

### File Operations

```bash
# Get file metadata
node index.js info 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms --summary

# Read text file content
node index.js read 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms

# Download file to tmp/
node index.js download 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms -o tmp/document.pdf

# Export Google Doc as PDF
node index.js download 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms --export "application/pdf" -o tmp/doc.pdf
```

### Upload & Create

```bash
# Upload file
node index.js upload ./local-file.txt --summary

# Upload with custom name
node index.js upload ./file.txt --name "My Document.txt" --summary

# Upload to specific folder
node index.js upload ./file.txt --parent 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms --summary

# Create folder
node index.js mkdir "New Project" --summary

# Create folder in parent
node index.js mkdir "Subfolder" --parent 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms --summary
```

### Storage Info

```bash
# Check storage quota
node index.js quota --summary
```

## Output Formats

- **`--summary`**: Human-readable with emojis 📁📄🔍
- **`--json`**: Raw JSON for programmatic use
- **Default**: Detailed text output with all metadata

## Export MIME Types

For Google Workspace files, use `--export` with these MIME types:

| Google Type | Export Options |
|-------------|----------------|
| **Google Docs** | `application/pdf`, `text/plain`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| **Google Sheets** | `text/csv`, `application/pdf`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| **Google Slides** | `application/pdf`, `text/plain` |

## Error Handling

The CLI provides helpful error messages:

- **Token not configured**: Shows exact setup instructions
- **Network permission denied**: Suggests permission flags
- **File not found**: Clear file ID validation
- **Quota exceeded**: Storage limit warnings

## Compatibility

- ✅ **Sandbox-first design** - No ES modules or async/await
- ✅ **CommonJS modules** - Uses `require()` only
- ✅ **Synchronous operations** - Built for sandbox constraints
- ✅ **PAVE token system** - Secure by design
- ✅ **Node.js 16+** - Compatible with target platform

## License

MIT License - see LICENSE file for details.