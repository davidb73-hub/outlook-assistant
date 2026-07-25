const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const BLOCKED_EXTENSIONS = new Set([
  '.ade',
  '.adp',
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.dll',
  '.exe',
  '.hta',
  '.iso',
  '.js',
  '.jse',
  '.lnk',
  '.msi',
  '.ps1',
  '.scr',
  '.sh',
  '.vba',
  '.vbe',
  '.vbs',
  '.wsf',
  '.wsh',
  '.xll',
]);
const CACHEABLE_BLOB_STATUSES = new Set(['safe', 'quarantined']);

function extensionRisk(fileName = '') {
  return BLOCKED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function filenamePolicyVerdict(fileName = '') {
  if (!extensionRisk(fileName)) return null;
  return {
    status: 'blocked',
    scanner: 'policy',
    reason: 'active-content-file-type',
  };
}

function isCacheableBlobVerdict(verdict) {
  return (
    CACHEABLE_BLOB_STATUSES.has(verdict?.status) &&
    verdict?.scanner !== 'policy'
  );
}

async function scanAttachment({ filePath, fileName, clamscanPath }) {
  const policyVerdict = filenamePolicyVerdict(fileName);
  if (policyVerdict) return policyVerdict;
  if (!clamscanPath) {
    return {
      status: 'scanner_unavailable',
      scanner: 'clamav',
      reason: 'scanner-not-configured',
    };
  }
  try {
    await fs.access(filePath);
    const result = await execFileAsync(
      clamscanPath,
      ['--no-summary', '--', filePath],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      }
    );
    return {
      status: 'safe',
      scanner: 'clamav',
      scannerVersion: result.stdout.trim() || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        status: 'scanner_unavailable',
        scanner: 'clamav',
        reason: 'clamscan-not-installed',
      };
    }
    if (error.code === 1) {
      return {
        status: 'quarantined',
        scanner: 'clamav',
        reason: 'malware-detected',
      };
    }
    return {
      status: 'scanner_unavailable',
      scanner: 'clamav',
      reason: 'scan-failed',
    };
  }
}

function isTriageEligible(status) {
  return status === 'safe';
}

module.exports = {
  BLOCKED_EXTENSIONS,
  CACHEABLE_BLOB_STATUSES,
  extensionRisk,
  filenamePolicyVerdict,
  isCacheableBlobVerdict,
  scanAttachment,
  isTriageEligible,
};
