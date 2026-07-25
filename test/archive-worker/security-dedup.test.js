const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveService } = require('../../archive-worker/archive-service');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  isCacheableBlobVerdict,
} = require('../../archive-worker/security-gate');
const { ContentStore, sha256 } = require('../../archive-worker/storage');

// Scanning was keyed to attachment_id, so identical content was rescanned for every
// message it appeared in. On the live archive that meant 20,358 attachment rows for
// only 7,494 distinct blobs — and one signature image (footer-illustration.png)
// occurring 369 times. Verdicts are now keyed to the content hash.

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-dedup-'));
  return { db: new ArchiveDatabase(path.join(dir, 'a.sqlite3')), dir };
}

describe('attachment security verdicts are keyed to content, not occurrence', () => {
  let ctx;
  beforeEach(() => {
    ctx = tempDb();
  });
  afterEach(() => {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  test('an unscanned hash returns null so the caller knows to scan', () => {
    expect(ctx.db.getBlobSecurity('deadbeef')).toBeNull();
  });

  test('a recorded verdict is returned for the same content', () => {
    ctx.db.recordBlobSecurity('hash-abc', {
      status: 'safe',
      scanner: 'clamav',
      scannerVersion: '1.5.3',
      reason: null,
    });
    const got = ctx.db.getBlobSecurity('hash-abc');
    expect(got.status).toBe('safe');
    expect(got.scanner).toBe('clamav');
    expect(got.fromCache).toBe(true);
  });

  test('the same image in 369 messages is stored once', () => {
    for (let i = 0; i < 369; i += 1) {
      ctx.db.recordBlobSecurity('signature-png-hash', {
        status: 'safe',
        scanner: 'clamav',
        reason: null,
      });
    }
    const rows = ctx.db.db
      .prepare('SELECT COUNT(*) AS n FROM attachment_security_blob')
      .get();
    expect(rows.n).toBe(1);
  });

  test('distinct content gets distinct verdicts', () => {
    ctx.db.recordBlobSecurity('clean-hash', {
      status: 'safe',
      scanner: 'clamav',
    });
    ctx.db.recordBlobSecurity('nasty-hash', {
      status: 'quarantined',
      scanner: 'clamav',
      reason: 'malware-detected',
    });
    expect(ctx.db.getBlobSecurity('clean-hash').status).toBe('safe');
    expect(ctx.db.getBlobSecurity('nasty-hash').status).toBe('quarantined');
    expect(ctx.db.getBlobSecurity('nasty-hash').reason).toBe(
      'malware-detected'
    );
  });

  test('a re-scan overwrites rather than duplicating (new signatures, new verdict)', () => {
    ctx.db.recordBlobSecurity('h', {
      status: 'safe',
      scanner: 'clamav',
      scannerVersion: '1.0',
    });
    ctx.db.recordBlobSecurity('h', {
      status: 'quarantined',
      scanner: 'clamav',
      scannerVersion: '2.0',
      reason: 'malware-detected',
    });
    const got = ctx.db.getBlobSecurity('h');
    expect(got.status).toBe('quarantined');
    expect(got.scannerVersion).toBe('2.0');
    const rows = ctx.db.db
      .prepare('SELECT COUNT(*) AS n FROM attachment_security_blob')
      .get();
    expect(rows.n).toBe(1);
  });

  test('a null hash is ignored rather than throwing', () => {
    expect(() =>
      ctx.db.recordBlobSecurity(null, { status: 'safe', scanner: 'x' })
    ).not.toThrow();
    expect(ctx.db.getBlobSecurity(null)).toBeNull();
  });

  test('only valid statuses are accepted', () => {
    expect(() =>
      ctx.db.recordBlobSecurity('h2', {
        status: 'probably-fine',
        scanner: 'clamav',
      })
    ).toThrow();
  });

  test('same bytes cached safe under a benign name are still blocked as payload.exe', async () => {
    const contentStore = new ContentStore(ctx.dir);
    const service = new ArchiveService({ database: ctx.db, contentStore });
    await service.initialise([
      {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
      },
    ]);
    const bytes = Buffer.from('same attachment bytes');
    const contentHash = sha256(bytes);
    ctx.db.recordBlobSecurity(contentHash, {
      status: 'safe',
      scanner: 'clamav',
      scannerVersion: 'fixture',
    });
    const stage = (providerMessageId, fileName) =>
      service.stageMessage(
        'gmail-personal',
        {
          providerMessageId,
          direction: 'inbound',
          bodyText: '',
          hasAttachments: true,
          attachments: [
            {
              providerAttachmentId: `attachment-${providerMessageId}`,
              fileName,
              mediaType: 'application/octet-stream',
            },
          ],
        },
        Buffer.from(`raw-${providerMessageId}`)
      );
    const logo = await stage('logo-message', 'logo.png');
    const payload = await stage('payload-message', 'payload.exe');

    await service.completeAttachment(
      logo.id,
      'attachment-logo-message',
      bytes,
      'application/octet-stream'
    );
    await service.completeAttachment(
      payload.id,
      'attachment-payload-message',
      bytes,
      'application/octet-stream'
    );

    const statuses = Object.fromEntries(
      ctx.db.db
        .prepare(
          `SELECT a.file_name, s.status
             FROM attachment_security s
             JOIN attachments a ON a.id = s.attachment_id`
        )
        .all()
        .map((row) => [row.file_name, row.status])
    );
    expect(statuses).toEqual({
      'logo.png': 'safe',
      'payload.exe': 'blocked',
    });
    expect(ctx.db.getBlobSecurity(contentHash)).toEqual(
      expect.objectContaining({ status: 'safe', scanner: 'clamav' })
    );
  });
});

describe('only content-derived security verdicts are reusable by hash', () => {
  test.each(['safe', 'quarantined'])('%s is cacheable', (status) => {
    expect(isCacheableBlobVerdict({ status, scanner: 'clamav' })).toBe(true);
  });

  test.each(['blocked', 'scanner_unavailable', 'pending'])(
    '%s is not cacheable',
    (status) => {
      expect(
        isCacheableBlobVerdict({
          status,
          scanner: status === 'blocked' ? 'policy' : 'clamav',
        })
      ).toBe(false);
    }
  );

  test('a malformed verdict is not cacheable', () => {
    for (const verdict of [null, undefined, {}, { status: 'unexpected' }]) {
      expect(isCacheableBlobVerdict(verdict)).toBe(false);
    }
  });
});
