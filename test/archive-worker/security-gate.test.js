const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  extensionRisk,
  isTriageEligible,
  scanAttachment,
} = require('../../archive-worker/security-gate');

describe('attachment security gate', () => {
  test('blocks active content by policy before scanner execution', async () => {
    expect(extensionRisk('invoice.xlsm')).toBe(false);
    expect(extensionRisk('invoice.exe')).toBe(true);
    const result = await scanAttachment({
      filePath: '/does/not/matter',
      fileName: 'invoice.exe',
    });
    expect(result).toEqual({
      status: 'blocked',
      scanner: 'policy',
      reason: 'active-content-file-type',
    });
    expect(isTriageEligible(result.status)).toBe(false);
  });

  test('fails closed when ClamAV is unavailable', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'email-security-')
    );
    const filePath = path.join(directory, 'note.txt');
    await fs.writeFile(filePath, 'untrusted content');
    const result = await scanAttachment({
      filePath,
      fileName: 'note.txt',
      clamscanPath: 'definitely-not-installed',
    });
    expect(result.status).toBe('scanner_unavailable');
    expect(isTriageEligible(result.status)).toBe(false);
    await fs.rm(directory, { recursive: true, force: true });
  });
});
