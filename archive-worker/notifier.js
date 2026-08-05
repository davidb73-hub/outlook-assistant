const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_NOTIFIER_PATH = '/opt/homebrew/bin/terminal-notifier';
const DEFAULT_OPEN_COMMAND = path.join(
  os.homedir(),
  'Developer',
  'command-centre',
  'open-briefing'
);

function appleScriptString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/[\r\n]+/g, ' ')}"`;
}

function notifyMac({
  title,
  message,
  group = 'com.davidbasseal.email-assistant-archive',
  execFileImpl = execFile,
  existsSyncImpl = fs.existsSync,
  notifierPath = process.env.TERMINAL_NOTIFIER_PATH || DEFAULT_NOTIFIER_PATH,
  openCommand = process.env.COMMAND_CENTRE_OPEN || DEFAULT_OPEN_COMMAND,
}) {
  return new Promise((resolve) => {
    if (!existsSyncImpl(notifierPath)) {
      resolve({ status: 'unavailable', errorCode: 'NOTIFIER_NOT_INSTALLED' });
      return;
    }
    const args = ['-title', title, '-message', message, '-group', group];
    if (existsSyncImpl(openCommand)) args.push('-execute', openCommand);
    execFileImpl(notifierPath, args, { timeout: 10_000 }, (error) => {
      resolve(
        error
          ? {
              status: 'unavailable',
              errorCode: error.code || 'NOTIFY_FAILED',
            }
          : { status: 'sent' }
      );
    });
  });
}

function notifyArchiveFailure(options = {}) {
  return notifyMac({
    title: 'Email archive needs attention',
    message:
      'One or more mail sources paused. Open Command Centre to see the affected account and recovery action.',
    group: 'com.davidbasseal.email-assistant-archive.failure',
    ...options,
  });
}

function notifyArchiveRecovery(options = {}) {
  return notifyMac({
    title: 'Email archive recovered',
    message: 'All configured mail sources are archiving normally again.',
    group: 'com.davidbasseal.email-assistant-archive.failure',
    ...options,
  });
}

module.exports = {
  appleScriptString,
  notifyArchiveFailure,
  notifyArchiveRecovery,
  notifyMac,
};
