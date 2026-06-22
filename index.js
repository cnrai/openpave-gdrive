#!/usr/bin/env node
/**
 * Google Drive CLI - Secure Token Version
 * 
 * Uses the PAVE sandbox secure token system for authentication.
 * Tokens are never visible to sandbox code - they're injected by the host.
 * 
 * Token configuration in ~/.pave/permissions.yaml:
 * {
 *   "tokens": {
 *     "gdrive": {
 *       "env": "GDRIVE_ACCESS_TOKEN",
 *       "type": "oauth",
 *       "domains": ["www.googleapis.com", "*.googleapis.com"],
 *       "placement": { "type": "header", "name": "Authorization", "format": "Bearer {token}" },
 *       "refreshEnv": "GDRIVE_REFRESH_TOKEN",
 *       "refreshUrl": "https://oauth2.googleapis.com/token",
 *       "clientIdEnv": "GDRIVE_CLIENT_ID",
 *       "clientSecretEnv": "GDRIVE_CLIENT_SECRET"
 *     }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments  
const args = process.argv.slice(2);

function parseArgs() {
  const parsed = {
    command: null,
    positional: [],
    options: {}
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=', 2);
        if (value !== undefined) {
          parsed.options[key] = value;
        } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          parsed.options[key] = args[i + 1];
          i++;
        } else {
          parsed.options[key] = true;
        }
      } else {
        const flag = arg.slice(1);
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          parsed.options[flag] = args[i + 1];
          i++;
        } else {
          parsed.options[flag] = true;
        }
      }
    } else {
      if (parsed.command === null) {
        parsed.command = arg;
      } else {
        parsed.positional.push(arg);
      }
    }
  }
  
  return parsed;
}

// URL encoding function for sandbox compatibility
function encodeFormData(data) {
  const params = [];
  for (const [key, value] of Object.entries(data)) {
    // encodeURIComponent doesn't encode single quotes, but they must be
    // encoded for the Google Drive API when running through the PAVE sandbox.
    // The sandbox's shell quoting of URLs interferes with unencoded single quotes.
    const encodedKey = encodeURIComponent(key).replace(/'/g, '%27');
    const encodedValue = encodeURIComponent(value).replace(/'/g, '%27');
    params.push(`${encodedKey}=${encodedValue}`);
  }
  return params.join('&');
}

// Google Drive Client Class - Uses secure token system

// ── PAVE Auth Proxy (replaces deprecated authenticatedFetch global) ──
// Direct HTTP calls to the PAVE auth proxy at /proxy/:tokenName/*path
var PAVE_PROXY_BASE = process.env.PAVE_PROXY_URL || '';

function _shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function proxyHasToken(tokenName) {
  if (!PAVE_PROXY_BASE) return false;
  try {
    var url = PAVE_PROXY_BASE.replace(/\/$/, '') + '/_tokens/' + encodeURIComponent(tokenName);
    var out = require('child_process').execSync(
      'curl -sS --max-time 5 ' + _shellQuote(url),
      { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    var r = JSON.parse(out);
    return r.has === true;
  } catch (e) {
    return false;
  }
}

function proxyFetch(tokenName, url, options) {
  options = options || {};
  if (!PAVE_PROXY_BASE) {
    throw new Error('PAVE_PROXY_URL not set - cannot reach auth proxy');
  }

  var parsed = new URL(url);
  var proxyUrl = PAVE_PROXY_BASE.replace(/\/$/, '') + '/' + encodeURIComponent(tokenName) + parsed.pathname + parsed.search;
  proxyUrl += (proxyUrl.indexOf('?') !== -1 ? '&' : '?') + '_mode=json';
  if (options.saveTo) {
    proxyUrl += '&_saveTo=' + encodeURIComponent(options.saveTo);
  }

  var method = options.method || 'GET';
  var timeout = options.timeout || 30000;
  var cmd = 'curl -sS -X ' + method + ' --max-time ' + Math.ceil(timeout / 1000);

  var headers = Object.assign({}, options.headers || {});
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  for (var k in headers) {
    cmd += ' -H ' + _shellQuote(k + ': ' + headers[k]);
  }

  if (options.body) {
    var bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    cmd += ' -d ' + _shellQuote(bodyStr);
  }

  cmd += ' ' + _shellQuote(proxyUrl);

  var out;
  try {
    out = require('child_process').execSync(cmd, {
      encoding: 'utf8', timeout: timeout + 5000, maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    var stdout = err.stdout ? err.stdout.toString() : '';
    var stderr = err.stderr ? err.stderr.toString() : '';
    if (stdout) { out = stdout; } else {
      throw new Error('Proxy request failed: ' + (stderr.trim() || err.message));
    }
  }

  var resp;
  try { resp = JSON.parse(out); } catch (e) {
    return { ok: true, status: 200, headers: { get: function() { return null; } },
      text: function() { return out; }, json: function() { return JSON.parse(out || '{}'); } };
  }
  if (resp.error) throw new Error(resp.error);
  if (resp.savedTo) {
    return { ok: resp.ok || false, status: resp.status || 200, savedTo: resp.savedTo,
      headers: { get: function() { return null; } },
      text: function() { return ''; }, json: function() { return {}; } };
  }
  return { ok: resp.ok || false, status: resp.status || 200,
    headers: { get: function(name) { var hs = resp.headers || {}, ln = name.toLowerCase();
      for (var key in hs) { if (key.toLowerCase() === ln) return Array.isArray(hs[key]) ? hs[key][0] : hs[key]; }
      return null; } },
    text: function() { return resp.body || ''; }, json: function() { return JSON.parse(resp.body || '{}'); } };
}

class GDriveClient {
  constructor() {
    // Check if gdrive token is available via secure token system
    if (!proxyHasToken('gdrive')) {
      console.error('🚫 Google Drive token not configured.');
      console.error('');
      console.error('Add to ~/.pave/permissions.yaml:');
      console.error('');
      console.error('tokens:');
      console.error('  gdrive:');
      console.error('    env: GDRIVE_ACCESS_TOKEN');
      console.error('    type: oauth');
      console.error('    domains:');
      console.error('      - www.googleapis.com');
      console.error('      - "*.googleapis.com"');
      console.error('    placement:');
      console.error('      type: header');
      console.error('      name: Authorization');
      console.error('      format: "Bearer {token}"');
      console.error('    refreshEnv: GDRIVE_REFRESH_TOKEN');
      console.error('    refreshUrl: https://oauth2.googleapis.com/token');
      console.error('    clientIdEnv: GMAIL_CLIENT_ID');
      console.error('    clientSecretEnv: GMAIL_CLIENT_SECRET');
      console.error('');
      console.error('Then set environment variables:');
      console.error('  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN');
      console.error('');
      console.error('💡 Reuses Gmail OAuth app - only GDRIVE_REFRESH_TOKEN is new');
      throw new Error('Google Drive token not configured');
    }
    
    this.baseUrl = 'https://www.googleapis.com/drive/v3';
  }
  
  request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    
    // Use authenticatedFetch - token injection and OAuth refresh handled by sandbox
    const response = proxyFetch('gdrive', url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      timeout: options.timeout || 15000
    });
    
    if (!response.ok) {
      const error = response.json();
      const err = new Error(error.error?.message || `HTTP ${response.status}`);
      err.status = response.status;
      err.data = error;
      throw err;
    }
    
    return response.json();
  }
  
  // Binary request for file downloads
  requestBinary(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    
    const response = proxyFetch('gdrive', url, {
      ...options,
      headers: {
        ...options.headers
      },
      timeout: options.timeout || 30000
    });
    
    if (!response.ok) {
      try {
        const error = response.json();
        throw new Error(error.error?.message || `HTTP ${response.status}`);
      } catch (parseErr) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }
    
    return response;
  }
  
  listFiles(options = {}) {
    const paramData = {};
    
    // Build query
    const queryParts = [];
    if (options.q) {
      queryParts.push(options.q);
    }
    if (options.folderId) {
      queryParts.push(`'${options.folderId}' in parents`);
    }
    // Exclude trashed files by default
    queryParts.push('trashed = false');
    
    if (queryParts.length > 0) {
      paramData.q = queryParts.join(' and ');
    }

    paramData.pageSize = options.pageSize || 20;
    paramData.fields = 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, webViewLink, iconLink)';
    
    if (options.pageToken) paramData.pageToken = options.pageToken;
    if (options.orderBy) paramData.orderBy = options.orderBy;

    const queryString = encodeFormData(paramData);
    return this.request(`/files?${queryString}`);
  }

  searchFiles(query, options = {}) {
    const escapedQuery = query.replace(/'/g, "\\'");
    const searchQuery = `name contains '${escapedQuery}'`;
    return this.listFiles({ ...options, q: searchQuery });
  }

  getFile(fileId) {
    const paramData = {
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink, webContentLink, owners, shared'
    };
    const queryString = encodeFormData(paramData);
    return this.request(`/files/${fileId}?${queryString}`);
  }

  downloadFile(fileId) {
    const response = this.requestBinary(`/files/${fileId}?alt=media`);
    return response.text(); // Return as text for sandbox compatibility
  }

  exportFile(fileId, mimeType) {
    const paramData = { mimeType };
    const queryString = encodeFormData(paramData);
    const response = this.requestBinary(`/files/${fileId}/export?${queryString}`);
    return response.text();
  }

  getFileContent(fileId) {
    const file = this.getFile(fileId);
    
    // Handle Google Docs
    if (file.mimeType === 'application/vnd.google-apps.document') {
      return this.exportFile(fileId, 'text/plain');
    }
    
    // Handle Google Sheets
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      return this.exportFile(fileId, 'text/csv');
    }
    
    // Handle Google Slides
    if (file.mimeType === 'application/vnd.google-apps.presentation') {
      return this.exportFile(fileId, 'text/plain');
    }

    // Regular file - download directly
    return this.downloadFile(fileId);
  }

  createFolder(name, parentId = null) {
    const metadata = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    
    if (parentId) {
      metadata.parents = [parentId];
    }

    return this.request('/files', {
      method: 'POST',
      body: JSON.stringify(metadata),
    });
  }

  uploadFile(name, content, options = {}) {
    const metadata = {
      name,
    };
    
    if (options.parentId) {
      metadata.parents = [options.parentId];
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const mimeType = options.mimeType || 'application/octet-stream';

    const multipartBody = [
      delimiter,
      'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(metadata),
      delimiter,
      `Content-Type: ${mimeType}\r\n\r\n`,
      content,
      closeDelim,
    ].join('');

    const response = proxyFetch('gdrive', 
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!response.ok) {
      const data = response.json();
      throw new Error(data.error?.message || 'Upload failed');
    }

    return response.json();
  }

  getStorageQuota() {
    return this.request('/about?fields=storageQuota,user');
  }

  // Format file size for display
  static formatSize(bytes) {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = parseInt(bytes, 10);
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
  }

  // Check if file is a Google Workspace file
  static isGoogleWorkspaceFile(mimeType) {
    return mimeType && mimeType.startsWith('application/vnd.google-apps.');
  }

  // Get human-readable type from MIME type
  static getFileType(mimeType) {
    const types = {
      'application/vnd.google-apps.folder': 'Folder',
      'application/vnd.google-apps.document': 'Google Doc',
      'application/vnd.google-apps.spreadsheet': 'Google Sheet',
      'application/vnd.google-apps.presentation': 'Google Slides',
      'application/vnd.google-apps.form': 'Google Form',
      'application/vnd.google-apps.drawing': 'Google Drawing',
      'application/pdf': 'PDF',
      'image/png': 'PNG Image',
      'image/jpeg': 'JPEG Image',
      'text/plain': 'Text File',
      'text/csv': 'CSV',
      'application/json': 'JSON',
    };
    return types[mimeType] || mimeType || 'Unknown';
  }
}

// Command handlers
function handleLs(client, options, positional) {
  const folderId = positional[0] || 'root';
  const maxResults = parseInt(options.max || options.n) || 20;
  const orderBy = options.order || 'modifiedTime desc';

  const result = client.listFiles({
    folderId,
    pageSize: maxResults,
    orderBy,
  });

  if (options.summary) {
    const files = result.files || [];
    if (files.length === 0) {
      console.log('No files found.');
      return;
    }
    console.log(`Found ${files.length} item(s):\n`);
    for (const file of files) {
      const type = GDriveClient.getFileType(file.mimeType);
      const size = GDriveClient.formatSize(file.size);
      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
      const modified = new Date(file.modifiedTime).toLocaleDateString();
      console.log(`  ${isFolder ? '+' : '-'} ${file.name} (${type}, ${size}) ${modified}`);
    }
    console.log('');
  } else {
    console.log(JSON.stringify(result));
  }
}

function handleSearch(client, options, positional) {
  if (positional.length === 0) {
    console.error('Search query is required');
    process.exit(1);
  }

  const query = positional[0];
  const maxResults = parseInt(options.max || options.n) || 20;

  const result = client.searchFiles(query, {
    pageSize: maxResults,
  });

  if (options.summary) {
    const files = result.files || [];
    if (files.length === 0) {
      console.log(`No files found matching "${query}".`);
      return;
    }
    console.log(`Found ${files.length} result(s) for "${query}":\n`);
    for (const file of files) {
      const type = GDriveClient.getFileType(file.mimeType);
      const size = GDriveClient.formatSize(file.size);
      console.log(`  ${file.name} (${type}, ${size})`);
    }
    console.log('');
  } else {
    console.log(JSON.stringify(result));
  }
}

function handleInfo(client, options, positional) {
  if (positional.length === 0) {
    console.error('❌ File ID is required');
    process.exit(1);
  }

  const fileId = positional[0];
  const file = client.getFile(fileId);

  if (options.summary) {
    console.log(`File: ${file.name}`);
    console.log(`ID: ${file.id}`);
    console.log(`Type: ${GDriveClient.getFileType(file.mimeType)}`);
    console.log(`Size: ${GDriveClient.formatSize(file.size)}`);
    console.log(`Modified: ${file.modifiedTime}`);
    if (file.webViewLink) console.log(`Link: ${file.webViewLink}`);
  } else {
    console.log(JSON.stringify(file));
  }
}

function handleRead(client, options, positional) {
  if (positional.length === 0) {
    console.error('❌ File ID is required');
    process.exit(1);
  }

  const fileId = positional[0];
  const content = client.getFileContent(fileId);

  if (options.output || options.o) {
    const outputPath = options.output || options.o;
    fs.writeFileSync(outputPath, content);
    console.log(`💾 Content saved to ${outputPath}`);
  } else {
    console.log(content);
  }
}

function handleDownload(client, options, positional) {
  if (positional.length === 0) {
    console.error('❌ File ID is required');
    process.exit(1);
  }

  const fileId = positional[0];
  let outputPath = options.output || options.o;

  if (!outputPath) {
    console.error('❌ --output is required');
    process.exit(1);
  }

  // Ensure output is in tmp/ directory
  if (!outputPath.startsWith('tmp/')) {
    outputPath = `tmp/${path.basename(outputPath)}`;
  }

  let content;
  if (options.export) {
    content = client.exportFile(fileId, options.export);
  } else {
    content = client.downloadFile(fileId);
  }

  fs.writeFileSync(outputPath, content);
  console.log(`⬇️  Downloaded to ${outputPath} (${GDriveClient.formatSize(content.length)})`);
}

function handleUpload(client, options, positional) {
  if (positional.length === 0) {
    console.error('❌ Local path is required');
    process.exit(1);
  }

  const localPath = positional[0];
  
  if (!fs.existsSync(localPath)) {
    console.error(`❌ File not found: ${localPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(localPath, 'utf8');
  const name = options.name || options.n || path.basename(localPath);

  const result = client.uploadFile(name, content, {
    parentId: options.parent || options.p,
    mimeType: options.type || options.t,
  });

  if (options.summary) {
    console.log(`Uploaded: ${result.name} (ID: ${result.id})`);
  } else {
    console.log(JSON.stringify(result));
  }
}

function handleMkdir(client, options, positional) {
  if (positional.length === 0) {
    console.error('❌ Folder name is required');
    process.exit(1);
  }

  const name = positional[0];
  const result = client.createFolder(name, options.parent || options.p);

  if (options.summary) {
    console.log(`Created folder: ${result.name} (ID: ${result.id})`);
  } else {
    console.log(JSON.stringify(result));
  }
}

function handleQuota(client, options) {
  const result = client.getStorageQuota();

  if (options.summary) {
    const quota = result.storageQuota;
    const user = result.user;
    console.log(`Google Drive Storage for ${user.displayName} (${user.emailAddress})`);
    console.log(`Used: ${GDriveClient.formatSize(quota.usage)}`);
    console.log(`Limit: ${GDriveClient.formatSize(quota.limit)}`);
    if (quota.limit) {
      const percent = ((quota.usage / quota.limit) * 100).toFixed(1);
      console.log(`Usage: ${percent}%`);
    }
  } else {
    console.log(JSON.stringify(result));
  }
}

// Main execution
function main() {
  const parsed = parseArgs();
  
  if (!parsed.command) {
    console.error('Google Drive CLI - Secure Token Version');
    console.error('');
    console.error('Commands:');
    console.error('  ls [folderId]                List files in folder');
    console.error('  search <query>               Search files by name');
    console.error('  info <fileId>                Get file metadata');
    console.error('  read <fileId>                Read file content');
    console.error('  download <fileId>            Download file');
    console.error('  upload <localPath>           Upload file');
    console.error('  mkdir <name>                 Create folder');
    console.error('  quota                        Show storage quota');
    console.error('');
    console.error('Options:');
    console.error('  --summary                    Human-readable output');
    console.error('  -o, --output <file>          Output file path');
    console.error('');
    process.exit(1);
  }

  try {
    const client = new GDriveClient();

    switch (parsed.command) {
      case 'ls':
        handleLs(client, parsed.options, parsed.positional);
        break;
      case 'search':
        handleSearch(client, parsed.options, parsed.positional);
        break;
      case 'info':
        handleInfo(client, parsed.options, parsed.positional);
        break;
      case 'read':
        handleRead(client, parsed.options, parsed.positional);
        break;
      case 'download':
        handleDownload(client, parsed.options, parsed.positional);
        break;
      case 'upload':
        handleUpload(client, parsed.options, parsed.positional);
        break;
      case 'mkdir':
        handleMkdir(client, parsed.options, parsed.positional);
        break;
      case 'quota':
        handleQuota(client, parsed.options);
        break;
      default:
        console.error(`❌ Unknown command: ${parsed.command}`);
        process.exit(1);
    }
  } catch (error) {
    if (error.message.includes('token not configured')) {
      // Already handled in constructor
      process.exit(1);
    } else if (error.message.includes('Network permission denied')) {
      console.error('❌ Network permission required');
      console.error('💡 Run with: --allow-network=*.googleapis.com');
      process.exit(1);
    } else {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  }
}

main();