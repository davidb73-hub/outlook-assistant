const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  backfillAttachmentScans,
} = require('../../archive-worker/backfill-attachment-scans');

// The archive was bulk-hydrated with ~20k attachments that never passed the security
// gate, so they carry no 'safe' verdict and any delivery touching them is refused. The
// backfill scanner walks those attachments, scans the blob once per distinct content
// hash, and records the verdict — after which those messages become deliverable.

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const db = new ArchiveDatabase(path.join(dir, 'a.sqlite3'));
  db.upsertAccount({
    id: 'vitasci-outlook',
    provider: 'outlook',
    displayName: 'V',
  });
  return { db, dir };
}

// A ContentStore stub: blobPath returns a path we control; the scanner is faked.
function fakeStore(root) {
  return { blobPath: (_kind, hash) => path.join(root, `${hash}.blob`) };
}

function stageAttachment(
  db,
  { providerMessageId, attachId, fileName, blobHash }
) {
  const message = {
    providerMessageId,
    subject: 's',
    direction: 'inbound',
    bodyText: '',
    attachments: [
      { providerAttachmentId: attachId, fileName, mediaType: 'image/png' },
    ],
  };
  const staged = db.stageMessage('vitasci-outlook', message, {
    hash: `raw-${providerMessageId}`,
    kind: 'raw-message',
    relativePath: `raw/${providerMessageId}`,
    size: 1,
  });
  // The attachment blob must exist in the blobs table (FK), but with NO security verdict —
  // exactly the hydrated-but-unscanned shape.
  db.registerBlob({
    hash: blobHash,
    kind: 'attachment',
    relativePath: `attachments/${blobHash}`,
    size: 1,
  });
  db.db
    .prepare(
      "UPDATE attachments SET archive_state='complete', blob_hash=? WHERE message_id=? AND provider_attachment_id=?"
    )
    .run(blobHash, staged.id, attachId);
  return staged.id;
}

describe('backfillAttachmentScans', () => {
  let ctx;
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  test('scans an unscanned attachment and records a safe verdict', async () => {
    ctx = seed();
    stageAttachment(ctx.db, {
      providerMessageId: 'm1',
      attachId: 'att-1',
      fileName: 'image001.png',
      blobHash: 'a'.repeat(64),
    });
    const scan = jest.fn(async () => ({ status: 'safe', scanner: 'clamav' }));

    const summary = await backfillAttachmentScans({
      database: ctx.db,
      contentStore: fakeStore(ctx.dir),
      scan,
      clamscanPath: '/usr/bin/clamscan',
    });

    expect(summary.scanned).toBe(1);
    expect(summary.safe).toBe(1);
    const status = ctx.db.db
      .prepare('SELECT status FROM attachment_security LIMIT 1')
      .get().status;
    expect(status).toBe('safe');
  });

  test('scans identical content once (dedup by blob hash)', async () => {
    ctx = seed();
    const sharedHash = 'b'.repeat(64);
    for (const m of ['m1', 'm2', 'm3']) {
      stageAttachment(ctx.db, {
        providerMessageId: m,
        attachId: `att-${m}`,
        fileName: 'signature.png',
        blobHash: sharedHash,
      });
    }
    const scan = jest.fn(async () => ({ status: 'safe', scanner: 'clamav' }));

    const summary = await backfillAttachmentScans({
      database: ctx.db,
      contentStore: fakeStore(ctx.dir),
      scan,
      clamscanPath: '/usr/bin/clamscan',
    });

    // Three attachment rows updated, but the scanner ran only once.
    expect(scan).toHaveBeenCalledTimes(1);
    expect(summary.scanned + summary.cached).toBe(3);
    const rows = ctx.db.db
      .prepare(
        "SELECT COUNT(*) AS n FROM attachment_security WHERE status='safe'"
      )
      .get();
    expect(rows.n).toBe(3);
  });

  test('does not cache a non-terminal scanner_unavailable verdict', async () => {
    ctx = seed();
    stageAttachment(ctx.db, {
      providerMessageId: 'm1',
      attachId: 'att-1',
      fileName: 'x.png',
      blobHash: 'c'.repeat(64),
    });
    const scan = jest.fn(async () => ({
      status: 'scanner_unavailable',
      scanner: 'clamav',
      reason: 'scan-failed',
    }));

    const summary = await backfillAttachmentScans({
      database: ctx.db,
      contentStore: fakeStore(ctx.dir),
      scan,
      clamscanPath: '/usr/bin/clamscan',
    });

    expect(summary.unavailable).toBe(1);
    // Blob-level cache must stay empty so a later run retries after the scanner is fixed.
    const cached = ctx.db.getBlobSecurity('c'.repeat(64));
    expect(cached).toBeNull();
  });

  test('applies filename policy per occurrence without poisoning the content cache', async () => {
    ctx = seed();
    const sharedHash = 'd'.repeat(64);
    stageAttachment(ctx.db, {
      providerMessageId: 'blocked-first',
      attachId: 'att-blocked',
      fileName: 'payload.exe',
      blobHash: sharedHash,
    });
    stageAttachment(ctx.db, {
      providerMessageId: 'safe-second',
      attachId: 'att-safe',
      fileName: 'logo.png',
      blobHash: sharedHash,
    });
    const scan = jest.fn(() => ({ status: 'safe', scanner: 'clamav' }));

    const summary = await backfillAttachmentScans({
      database: ctx.db,
      contentStore: fakeStore(ctx.dir),
      scan,
      clamscanPath: '/usr/bin/clamscan',
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(summary).toEqual(
      expect.objectContaining({ scanned: 1, safe: 1, blocked: 1 })
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
      'payload.exe': 'blocked',
      'logo.png': 'safe',
    });
    expect(ctx.db.getBlobSecurity(sharedHash)).toEqual(
      expect.objectContaining({ status: 'safe', scanner: 'clamav' })
    );
  });
});
