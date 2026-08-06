#!/usr/bin/env node
const fs = require('fs/promises');
const { constants } = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LABEL = 'com.davidbasseal.email-assistant-archive';
const STABLE_NODE_22 = '/opt/homebrew/opt/node@22/bin/node';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plist({
  nodePath,
  workerPath,
  workingDirectory,
  intervalSeconds = 900,
  standardOutPath = path.join(
    os.homedir(),
    'Library',
    'Logs',
    'vitasci',
    'email-assistant-archive.out.log'
  ),
  standardErrorPath = path.join(
    os.homedir(),
    'Library',
    'Logs',
    'vitasci',
    'email-assistant-archive.err.log'
  ),
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(workerPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Number(intervalSeconds)}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(standardErrorPath)}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stderr });
      else reject(new Error(`launchctl failed: ${stderr.trim()}`));
    });
  });
}

async function preferredNodePath(
  fallback = process.execPath,
  access = fs.access
) {
  try {
    await access(STABLE_NODE_22, constants.X_OK);
    return STABLE_NODE_22;
  } catch {
    return fallback;
  }
}

async function install({
  home = os.homedir(),
  nodePath = null,
  repoRoot = path.resolve(__dirname, '..'),
  launchctlRunner = runLaunchctl,
} = {}) {
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgents, `${LABEL}.plist`);
  const logsDir = path.join(home, 'Library', 'Logs', 'vitasci');
  const workerPath = path.join(repoRoot, 'archive-worker', 'scheduled.js');
  const resolvedNodePath = nodePath || (await preferredNodePath());
  await fs.access(workerPath);
  await fs.mkdir(launchAgents, { recursive: true, mode: 0o700 });
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    plistPath,
    plist({
      nodePath: resolvedNodePath,
      workerPath,
      workingDirectory: repoRoot,
      standardOutPath: path.join(logsDir, 'email-assistant-archive.out.log'),
      standardErrorPath: path.join(logsDir, 'email-assistant-archive.err.log'),
    }),
    { mode: 0o600 }
  );
  const domain = `gui/${process.getuid()}`;
  await launchctlRunner(['bootout', domain, plistPath], {
    allowFailure: true,
  });
  // A deliberately paused service remains in launchd's persistent disabled
  // map after bootout. Clear that state before bootstrap; otherwise launchd
  // rejects the valid plist with an opaque input/output error.
  await launchctlRunner(['enable', `${domain}/${LABEL}`]);
  await launchctlRunner(['bootstrap', domain, plistPath]);
  return { label: LABEL, plistPath, intervalMinutes: 15 };
}

if (require.main === module) {
  install()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`Scheduler installation failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  LABEL,
  STABLE_NODE_22,
  escapeXml,
  install,
  plist,
  preferredNodePath,
  runLaunchctl,
};
