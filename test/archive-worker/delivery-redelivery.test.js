const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  createFilesystemAdapter,
} = require('../../archive-worker/filesystem-adapters');
const {
  manifestDigest,
  createDeliveryManifest,
} = require('../../archive-worker/delivery-contract');

// Node reports an existing fs.cp target as ERR_FS_CP_EEXIST, not EEXIST — the bare
// string only appears in the message. The adapter guarded on 'EEXIST', so redelivery
// of an already-copied package threw instead of consulting the receipt, and jobs
// exhausted their retry limit into 'review'. These tests pin the real error code.

// Build through the real factory so the manifest stays valid if the contract moves.
function manifestFor(destination) {
  return createDeliveryManifest({
    message: {
      id: 4242,
      accountId: 'vitasci-outlook',
      providerMessageId: 'AAMkAD-quarterly',
      rawBlobHash: 'a'.repeat(64),
    },
    destinations: [destination],
    triage: {
      categories: ['finance'],
      confidence: 0.9,
      reason: 'known-sender',
    },
  });
}

function scaffold(destination) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeliver-'));
  const packageRoot = path.join(dir, 'package');
  const inboxPath = path.join(dir, 'inbox');
  const receiptRoot = path.join(dir, 'receipts');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(receiptRoot, { recursive: true });
  const manifest = manifestFor(destination);
  fs.writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify(manifest)
  );
  return {
    dir,
    packageRoot,
    inboxPath,
    receiptRoot,
    digest: manifestDigest(manifest),
  };
}

describe('redelivering an already-copied package', () => {
  let ctx;
  beforeEach(() => {
    ctx = scaffold('vitasci-crm');
  });
  afterEach(() => {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  const adapter = (receiptRoot) =>
    createFilesystemAdapter({
      destination: 'vitasci-crm',
      inboxPath: ctx.inboxPath,
      receiptRoot,
    });

  const writeReceipt = (body) =>
    fsp.writeFile(
      path.join(ctx.receiptRoot, `${ctx.digest}.receipt.json`),
      JSON.stringify(body)
    );

  test('the real error code from fs.cp is ERR_FS_CP_EEXIST, not EEXIST', async () => {
    const dst = path.join(ctx.dir, 'dst');
    await fsp.cp(ctx.packageRoot, dst, { recursive: true });
    const error = await fsp
      .cp(ctx.packageRoot, dst, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      .then(
        () => null,
        (e) => e
      );
    expect(error).not.toBeNull();
    expect(error.code).toBe('ERR_FS_CP_EEXIST');
    expect(error.code).not.toBe('EEXIST');
  });

  test('a second delivery with no receipt yet reports pending, not a throw', async () => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(ctx.receiptRoot).deliver(job);
    const second = await adapter(ctx.receiptRoot).deliver(job);
    expect(second.pending).toBe(true);
    expect(second.reason).toBe('awaiting-destination-receipt');
  });

  test('a second delivery resolves against an accepted receipt', async () => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(ctx.receiptRoot).deliver(job);
    await writeReceipt({ status: 'accepted', provenance_event_id: 'prov-9' });
    const second = await adapter(ctx.receiptRoot).deliver(job);
    expect(second.accepted).toBe(true);
    expect(second.destinationRecordId).toBe('prov-9');
    expect(second.manifestDigest).toBe(ctx.digest);
  });

  test('a rejecting receipt is reported as a rejection, not an error', async () => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(ctx.receiptRoot).deliver(job);
    await writeReceipt({ status: 'rejected', reasons: ['triage-junk'] });
    const second = await adapter(ctx.receiptRoot).deliver(job);
    expect(second.accepted).toBe(false);
    expect(second.pending).toBeFalsy();
    expect(second.reason).toBe('triage-junk');
  });

  // VitaSci's ack schema writes `reason` (string); Ruvocal writes `reasons` (array).
  // Reading only the array discarded every VitaSci explanation.
  test.each([
    ['a single reason string', { reason: 'triage-self' }, 'triage-self'],
    [
      'a reasons array',
      { reasons: ['triage-junk', 'no-match'] },
      'triage-junk,no-match',
    ],
    ['neither field', {}, 'destination-rejected'],
    ['an empty string', { reason: '   ' }, 'destination-rejected'],
    ['an empty array', { reasons: [] }, 'destination-rejected'],
  ])('a rejection carries %s through', async (_label, extra, expected) => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(ctx.receiptRoot).deliver(job);
    await writeReceipt({ status: 'rejected', ...extra });
    const second = await adapter(ctx.receiptRoot).deliver(job);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe(expected);
  });

  test('with no receipt root configured a duplicate is simply acknowledged', async () => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(null).deliver(job);
    const second = await adapter(null).deliver(job);
    expect(second.accepted).toBe(true);
    expect(second.duplicate).toBe(true);
  });

  test('the package is not re-copied when it is already present', async () => {
    const job = { packageRoot: ctx.packageRoot };
    await adapter(ctx.receiptRoot).deliver(job);
    // A marker the destination might have written while processing must survive.
    const marker = path.join(
      ctx.inboxPath,
      `${ctx.digest}.delivery`,
      'IN-PROGRESS'
    );
    fs.writeFileSync(marker, 'destination is mid-read');
    await adapter(ctx.receiptRoot).deliver(job);
    expect(fs.existsSync(marker)).toBe(true);
  });

  test('a genuine copy failure still propagates', async () => {
    const broken = createFilesystemAdapter({
      destination: 'vitasci-crm',
      inboxPath: ctx.inboxPath,
      receiptRoot: ctx.receiptRoot,
    });
    await expect(
      broken.deliver({ packageRoot: path.join(ctx.dir, 'does-not-exist') })
    ).rejects.toThrow();
  });
});
