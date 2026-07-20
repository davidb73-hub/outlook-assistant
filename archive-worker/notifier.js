const { execFile } = require('child_process');

function appleScriptString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/[\r\n]+/g, ' ')}"`;
}

function notifyMac({ title, message, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    const script = `display notification ${appleScriptString(
      message
    )} with title ${appleScriptString(title)}`;
    execFileImpl(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: 10_000 },
      (error) => {
        resolve(
          error
            ? {
                status: 'unavailable',
                errorCode: error.code || 'NOTIFY_FAILED',
              }
            : { status: 'sent' }
        );
      }
    );
  });
}

function notifyArchiveFailure(options = {}) {
  return notifyMac({
    title: 'Email archive needs attention',
    message:
      'A mailbox sync, reconciliation, or encrypted backup failed. Run npm run archive:status in the Email Assistant repository.',
    ...options,
  });
}

module.exports = {
  appleScriptString,
  notifyArchiveFailure,
  notifyMac,
};
