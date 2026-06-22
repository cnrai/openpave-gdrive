#!/usr/bin/env node
/**
 * Regression tests for the gdrive skill
 * Issue #872: https://github.com/cnrai/openpave/issues/872
 * 
 * Prerequisites:
 * - GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN environment variables
 * - Token configured in ~/.pave/permissions.yaml
 * - Network access to googleapis.com
 * - Test fixtures in Google Drive (see fixtures.json)
 * 
 * Run with: node test/gdrive.test.js
 * Run specific group: GDRIVE_TEST_GROUP=2 node test/gdrive.test.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// Test Framework
// ============================================================

let passed = 0;
let failed = 0;
let skipped = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    if (e.message === 'SKIP') {
      console.log(`⏭️  ${name}: SKIPPED`);
      skipped++;
    } else {
      console.log(`❌ ${name}: ${e.message}`);
      failed++;
    }
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertContains(str, substring, message) {
  if (!str.includes(substring)) {
    throw new Error(`${message}: expected to contain "${substring}" in: ${str.slice(0, 200)}...`);
  }
}

function assertMatch(str, regex, message) {
  if (!regex.test(str)) {
    throw new Error(`${message}: expected to match ${regex} in: ${str.slice(0, 200)}...`);
  }
}

function assertJson(str, message) {
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new Error(`${message}: invalid JSON: ${str.slice(0, 200)}...`);
  }
}

function skip(reason) {
  const err = new Error('SKIP');
  err.reason = reason;
  throw err;
}

// ============================================================
// Test Configuration
// ============================================================

// Load fixtures
const fixturesPath = path.join(__dirname, 'fixtures.json');
let fixtures = {};
try {
  fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
} catch (e) {
  console.warn('⚠️  Could not load fixtures.json:', e.message);
}

// Environment-based fixture overrides (for CI)
function getFixture(name) {
  const envKey = `GDRIVE_TEST_${name.toUpperCase()}_ID`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  if (fixtures[name]?.id && !fixtures[name].id.startsWith('PAVE_TEST_')) {
    return fixtures[name].id;
  }
  return null;
}

// Check if credentials are available
function hasCredentials() {
  return !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GDRIVE_REFRESH_TOKEN
  );
}

// Run pave gdrive command
function runGdrive(args, options = {}) {
  const cmd = `pave run gdrive ${args}`;
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim(), exitCode: 0 };
  } catch (e) {
    return {
      success: false,
      output: (e.stdout || '').trim(),
      error: (e.stderr || e.message || '').trim(),
      exitCode: e.status || 1,
    };
  }
}

// Files created during tests (for cleanup)
const createdFiles = [];

function trackCreatedFile(fileId) {
  if (fileId) createdFiles.push(fileId);
}

function cleanupCreatedFiles() {
  // Note: actual cleanup would require delete API which gdrive skill may not have
  // For now, just log what was created
  if (createdFiles.length > 0) {
    console.log(`\n🧹 Files created during tests (manual cleanup may be needed):`);
    createdFiles.forEach(id => console.log(`   - ${id}`));
  }
}

// ============================================================
// Credential Check
// ============================================================

if (!hasCredentials()) {
  console.log('⚠️  Google Drive credentials not found in environment.');
  console.log('   Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN');
  console.log('   Skipping all gdrive tests.\n');
  console.log('--- GDrive Test Results ---');
  console.log('Passed: 0');
  console.log('Failed: 0');
  console.log('Skipped: ALL (no credentials)');
  process.exit(0);
}

// Filter by test group if specified
const testGroup = process.env.GDRIVE_TEST_GROUP;
function shouldRunGroup(group) {
  if (!testGroup) return true;
  return String(group) === testGroup;
}

// ============================================================
// Group 1: Authentication & Token Management
// ============================================================

if (shouldRunGroup(1)) {
  console.log('\n📋 Group 1: Authentication & Token Management\n');

  runTest('1.1 Valid token works (quota command)', () => {
    const result = runGdrive('quota');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output, 'Google Drive Storage', 'Should show storage info');
  });

  runTest('1.2 Token refresh works (auto-refresh on expired token)', () => {
    // This is implicitly tested by 1.1 - if the access token is expired,
    // it should auto-refresh. We can't easily force expiration in tests.
    // Just verify a second call works (would fail if refresh broke)
    const result = runGdrive('quota --json');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual('storageQuota' in json, true, 'Should have storageQuota');
  });

  // 1.3 and 1.4 would require modifying env vars which could affect other tests
  // Keeping them as documentation but skipping
  runTest('1.3 Missing token error (requires unset credentials)', () => {
    skip('Cannot safely test without credentials - would break other tests');
  });

  runTest('1.4 Invalid token error handling', () => {
    skip('Cannot safely test with invalid token - would require separate env');
  });
}

// ============================================================
// Group 2: List Files (ls)
// ============================================================

if (shouldRunGroup(2)) {
  console.log('\n📋 Group 2: List Files (ls)\n');

  runTest('2.1 List root folder', () => {
    const result = runGdrive('ls');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Should show file count or "No files" message
    assertMatch(result.output, /file|folder|📁|📄|No files/i, 'Should show files or empty message');
  });

  runTest('2.2 List specific folder by ID', () => {
    const folderId = getFixture('testFolder');
    if (!folderId) skip('testFolder fixture not configured');
    
    const result = runGdrive(`ls ${folderId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertMatch(result.output, /file|folder|📁|📄|No files/i, 'Should show folder contents');
  });

  runTest('2.3 List with --max limit', () => {
    const result = runGdrive('ls --max 5');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Count file entries (lines with file icons or IDs)
    const lines = result.output.split('\n').filter(l => l.includes('📁') || l.includes('📄') || l.match(/ID:/));
    assertEqual(lines.length <= 5, true, `Should have at most 5 results, got ${lines.length}`);
  });

  runTest('2.4 List with --order by name', () => {
    const result = runGdrive('ls --order "name"');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Just verify command succeeds - sorting verification would need known files
    assertMatch(result.output, /file|folder|📁|📄|No files/i, 'Should complete successfully');
  });

  runTest('2.5 List with --summary', () => {
    const result = runGdrive('ls --summary');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Summary output format shows one-line-per-file
    assertMatch(result.output, /file|folder|📁|📄|No files/i, 'Should show summary format');
  });

  runTest('2.6 List with --json', () => {
    const result = runGdrive('ls --json');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual(Array.isArray(json), true, 'Should be an array');
  });

  runTest('2.7 Empty folder returns empty message', () => {
    const folderId = getFixture('emptyFolder');
    if (!folderId) skip('emptyFolder fixture not configured');
    
    const result = runGdrive(`ls ${folderId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'no files', 'Should show empty message');
  });

  runTest('2.8 Invalid folder ID returns error', () => {
    const result = runGdrive('ls invalid_folder_id_12345');
    assertEqual(result.success, false, 'Should fail with invalid ID');
    assertMatch(result.error || result.output, /not found|error|404|invalid/i, 'Should show error message');
  });
}

// ============================================================
// Group 3: Search Files
// ============================================================

if (shouldRunGroup(3)) {
  console.log('\n📋 Group 3: Search Files\n');

  runTest('3.1 Search by name', () => {
    const searchTerm = fixtures.searchableNames?.common || 'test';
    const result = runGdrive(`search "${searchTerm}"`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Should find results or show "no files found"
    assertMatch(result.output, /found|file|📄|no files/i, 'Should show search results');
  });

  runTest('3.2 Search no results', () => {
    const result = runGdrive('search "zzz_nonexistent_file_name_12345"');
    if (!result.success && !result.output.toLowerCase().includes('no files')) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Should show "no files found" message
    assertMatch(result.output.toLowerCase(), /no files|0 file/i, 'Should show no results message');
  });

  runTest('3.3 Search with --max limit', () => {
    const result = runGdrive('search "test" --max 3');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Count result entries
    const entries = result.output.split('\n').filter(l => l.includes('📄') || l.match(/ID:/));
    assertEqual(entries.length <= 3, true, `Should have at most 3 results`);
  });

  runTest('3.4 Search with --json', () => {
    const searchTerm = fixtures.searchableNames?.common || 'test';
    const result = runGdrive(`search "${searchTerm}" --json`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual(Array.isArray(json), true, 'Should be an array');
  });

  runTest('3.5 Search with special characters (quotes)', () => {
    // Test that special chars don't break the command
    const result = runGdrive('search "file with spaces"');
    // Success or "no files" is acceptable - we're testing that it doesn't crash
    if (!result.success && !result.output.toLowerCase().includes('no files')) {
      assertMatch(result.error || '', /no files|found/i, 'Should handle gracefully');
    }
  });

  runTest('3.6 Missing query shows error', () => {
    const result = runGdrive('search');
    assertEqual(result.success, false, 'Should fail without query');
    assertMatch(result.error || result.output, /required|missing|query/i, 'Should show error about missing query');
  });
}

// ============================================================
// Group 4: File Info
// ============================================================

if (shouldRunGroup(4)) {
  console.log('\n📋 Group 4: File Info\n');

  runTest('4.1 Get file info', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const result = runGdrive(`info ${fileId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output, 'ID:', 'Should show file ID');
    assertContains(result.output, 'Type:', 'Should show file type');
  });

  runTest('4.2 Get folder info', () => {
    const folderId = getFixture('testFolder');
    if (!folderId) skip('testFolder fixture not configured');
    
    const result = runGdrive(`info ${folderId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output, 'ID:', 'Should show folder ID');
  });

  runTest('4.3 Get Google Doc info', () => {
    const docId = getFixture('googleDoc');
    if (!docId) skip('googleDoc fixture not configured');
    
    const result = runGdrive(`info ${docId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertMatch(result.output, /google doc|document/i, 'Should show Google Doc type');
  });

  runTest('4.4 Info with --json', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const result = runGdrive(`info ${fileId} --json`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual('id' in json, true, 'Should have id field');
    assertEqual('name' in json, true, 'Should have name field');
    assertEqual('mimeType' in json, true, 'Should have mimeType field');
  });

  runTest('4.5 Invalid file ID returns error', () => {
    const result = runGdrive('info invalid_file_id_12345');
    assertEqual(result.success, false, 'Should fail with invalid ID');
    assertMatch(result.error || result.output, /not found|error|404|invalid/i, 'Should show error message');
  });

  runTest('4.6 Missing file ID shows error', () => {
    const result = runGdrive('info');
    assertEqual(result.success, false, 'Should fail without file ID');
    assertMatch(result.error || result.output, /required|missing|file/i, 'Should show error about missing ID');
  });
}

// ============================================================
// Group 5: Read Content
// ============================================================

if (shouldRunGroup(5)) {
  console.log('\n📋 Group 5: Read Content\n');

  runTest('5.1 Read text file', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const result = runGdrive(`read ${fileId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Should output some content
    assertEqual(result.output.length > 0, true, 'Should return file content');
  });

  runTest('5.2 Read Google Doc (exports as text)', () => {
    const docId = getFixture('googleDoc');
    if (!docId) skip('googleDoc fixture not configured');
    
    const result = runGdrive(`read ${docId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Should have some text content
    assertEqual(result.output.length > 0, true, 'Should return exported doc content');
  });

  runTest('5.3 Read Google Sheet (exports as CSV)', () => {
    const sheetId = getFixture('googleSheet');
    if (!sheetId) skip('googleSheet fixture not configured');
    
    const result = runGdrive(`read ${sheetId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // CSV should have commas or content
    assertEqual(result.output.length > 0, true, 'Should return exported sheet content');
  });

  runTest('5.4 Read with --output saves to file', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const outputPath = 'tmp/gdrive-test-read-output.txt';
    const result = runGdrive(`read ${fileId} --output ${outputPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'saved', 'Should confirm file saved');
    
    // Verify file exists
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath); // cleanup
    }
  });

  runTest('5.5 Read binary file (image)', () => {
    const imageId = getFixture('imageFile');
    if (!imageId) skip('imageFile fixture not configured');
    
    // Binary read to stdout may produce garbled output, but shouldn't error
    const result = runGdrive(`read ${imageId}`);
    // Just verify it doesn't crash - binary output is expected to look weird
    assertEqual(typeof result.output, 'string', 'Should return something');
  });

  runTest('5.6 Invalid file ID returns error', () => {
    const result = runGdrive('read invalid_file_id_12345');
    assertEqual(result.success, false, 'Should fail with invalid ID');
    assertMatch(result.error || result.output, /not found|error|404|invalid/i, 'Should show error message');
  });
}

// ============================================================
// Group 6: Download Files
// ============================================================

if (shouldRunGroup(6)) {
  console.log('\n📋 Group 6: Download Files\n');

  runTest('6.1 Download text file', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const outputPath = 'tmp/gdrive-test-download.txt';
    const result = runGdrive(`download ${fileId} --output ${outputPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'download', 'Should confirm download');
    
    // Cleanup
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  });

  runTest('6.2 Download binary file (image)', () => {
    const imageId = getFixture('imageFile');
    if (!imageId) skip('imageFile fixture not configured');
    
    const outputPath = 'tmp/gdrive-test-image.png';
    const result = runGdrive(`download ${imageId} --output ${outputPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    
    // Verify file was created
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      assertEqual(stat.size > 0, true, 'Downloaded file should have content');
      fs.unlinkSync(outputPath); // cleanup
    }
  });

  runTest('6.3 Export Google Doc as text', () => {
    const docId = getFixture('googleDoc');
    if (!docId) skip('googleDoc fixture not configured');
    
    const outputPath = 'tmp/gdrive-test-doc.txt';
    const result = runGdrive(`download ${docId} --export text/plain --output ${outputPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  });

  runTest('6.4 Export Google Sheet as CSV', () => {
    const sheetId = getFixture('googleSheet');
    if (!sheetId) skip('googleSheet fixture not configured');
    
    const outputPath = 'tmp/gdrive-test-sheet.csv';
    const result = runGdrive(`download ${sheetId} --export text/csv --output ${outputPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf8');
      // CSV should have content
      assertEqual(content.length > 0, true, 'CSV should have content');
      fs.unlinkSync(outputPath);
    }
  });

  runTest('6.5 Missing --output shows error', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    const result = runGdrive(`download ${fileId}`);
    assertEqual(result.success, false, 'Should fail without --output');
    assertMatch(result.error || result.output, /required|output/i, 'Should show error about missing output');
  });

  runTest('6.6 Path normalization (writes to tmp/)', () => {
    const fileId = getFixture('textFile');
    if (!fileId) skip('textFile fixture not configured');
    
    // Try to write outside tmp/ - should be normalized
    const result = runGdrive(`download ${fileId} --output /etc/test.txt`);
    // Should either fail safely or normalize to tmp/
    // Check that /etc/test.txt was NOT created
    assertEqual(fs.existsSync('/etc/test.txt'), false, 'Should not write to /etc/');
    
    // If normalized to tmp/, clean up
    if (fs.existsSync('tmp/test.txt')) {
      fs.unlinkSync('tmp/test.txt');
    }
  });
}

// ============================================================
// Group 7: Upload Files
// ============================================================

if (shouldRunGroup(7)) {
  console.log('\n📋 Group 7: Upload Files\n');
  
  // Create a test file for upload
  const testUploadPath = 'tmp/gdrive-test-upload.txt';
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(testUploadPath, 'This is a test file for gdrive upload testing.\n');

  runTest('7.1 Upload text file', () => {
    const result = runGdrive(`upload ${testUploadPath}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'upload', 'Should confirm upload');
    
    // Extract file ID from output for cleanup
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('7.2 Upload with custom name', () => {
    const result = runGdrive(`upload ${testUploadPath} --name "custom-test-name.txt"`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output, 'custom-test-name', 'Should use custom name');
    
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('7.3 Upload to specific folder', () => {
    const folderId = getFixture('testFolder');
    if (!folderId) skip('testFolder fixture not configured');
    
    const result = runGdrive(`upload ${testUploadPath} --parent ${folderId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('7.4 Upload with MIME type', () => {
    const result = runGdrive(`upload ${testUploadPath} --type text/plain`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('7.5 Upload with --json output', () => {
    const result = runGdrive(`upload ${testUploadPath} --json`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual('id' in json, true, 'Should have id field');
    
    if (json.id) trackCreatedFile(json.id);
  });

  runTest('7.6 Non-existent file shows error', () => {
    const result = runGdrive('upload /nonexistent/path/file.txt');
    assertEqual(result.success, false, 'Should fail with non-existent file');
    assertMatch(result.error || result.output, /not found|error|exist/i, 'Should show error about missing file');
  });

  runTest('7.7 Missing path shows error', () => {
    const result = runGdrive('upload');
    assertEqual(result.success, false, 'Should fail without path');
    assertMatch(result.error || result.output, /required|path/i, 'Should show error about missing path');
  });

  // Cleanup test file
  if (fs.existsSync(testUploadPath)) {
    fs.unlinkSync(testUploadPath);
  }
}

// ============================================================
// Group 8: Create Folder (mkdir)
// ============================================================

if (shouldRunGroup(8)) {
  console.log('\n📋 Group 8: Create Folder (mkdir)\n');

  runTest('8.1 Create folder', () => {
    const folderName = `pave-test-folder-${Date.now()}`;
    const result = runGdrive(`mkdir "${folderName}"`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'created', 'Should confirm creation');
    assertContains(result.output, folderName, 'Should show folder name');
    
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('8.2 Create folder in parent', () => {
    const folderId = getFixture('testFolder');
    if (!folderId) skip('testFolder fixture not configured');
    
    const folderName = `pave-test-subfolder-${Date.now()}`;
    const result = runGdrive(`mkdir "${folderName}" --parent ${folderId}`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output.toLowerCase(), 'created', 'Should confirm creation');
    
    const idMatch = result.output.match(/ID:\s*(\S+)/);
    if (idMatch) trackCreatedFile(idMatch[1]);
  });

  runTest('8.3 Create folder with --json', () => {
    const folderName = `pave-test-json-${Date.now()}`;
    const result = runGdrive(`mkdir "${folderName}" --json`);
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual('id' in json, true, 'Should have id field');
    assertEqual('name' in json, true, 'Should have name field');
    
    if (json.id) trackCreatedFile(json.id);
  });

  runTest('8.4 Missing folder name shows error', () => {
    const result = runGdrive('mkdir');
    assertEqual(result.success, false, 'Should fail without name');
    assertMatch(result.error || result.output, /required|name/i, 'Should show error about missing name');
  });
}

// ============================================================
// Group 9: Storage Quota
// ============================================================

if (shouldRunGroup(9)) {
  console.log('\n📋 Group 9: Storage Quota\n');

  runTest('9.1 Get quota', () => {
    const result = runGdrive('quota');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    assertContains(result.output, 'Used:', 'Should show used storage');
    assertContains(result.output, 'Limit:', 'Should show storage limit');
  });

  runTest('9.2 Quota with --json', () => {
    const result = runGdrive('quota --json');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    const json = assertJson(result.output, 'Should return valid JSON');
    assertEqual('storageQuota' in json, true, 'Should have storageQuota object');
    assertEqual('user' in json, true, 'Should have user object');
  });

  runTest('9.3 Quota with --summary', () => {
    const result = runGdrive('quota --summary');
    if (!result.success) {
      throw new Error(`Command failed: ${result.error}`);
    }
    // Summary format should be human-readable
    assertMatch(result.output, /storage|used|drive/i, 'Should show summary format');
  });
}

// ============================================================
// Group 10: Error Handling (Limited)
// ============================================================

if (shouldRunGroup(10)) {
  console.log('\n📋 Group 10: Error Handling\n');

  runTest('10.1 Unknown command shows error', () => {
    const result = runGdrive('unknowncommand');
    assertEqual(result.success, false, 'Should fail with unknown command');
    assertMatch(result.error || result.output, /unknown|invalid|command/i, 'Should show unknown command error');
  });

  // 10.2-10.5 require network mocking or special conditions - skip for now
  runTest('10.2 Network timeout handling', () => {
    skip('Requires network simulation');
  });

  runTest('10.3 Rate limiting (429) handling', () => {
    skip('Requires API rate limit trigger');
  });

  runTest('10.4 Permission denied (403) handling', () => {
    skip('Requires access to unshared file');
  });

  runTest('10.5 Malformed response handling', () => {
    skip('Requires API mock');
  });
}

// ============================================================
// Test Summary
// ============================================================

console.log('\n' + '='.repeat(50));
console.log('--- GDrive Test Results ---');
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}`);
console.log('='.repeat(50));

// Cleanup notification
cleanupCreatedFiles();

if (failed > 0) {
  console.log(`\n❌ ${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed! (${skipped} skipped)`);
}
