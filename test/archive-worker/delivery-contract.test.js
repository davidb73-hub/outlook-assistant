const {
  createDeliveryManifest,
  validateDeliveryManifest,
  manifestDigest,
} = require('../../archive-worker/delivery-contract');

describe('delivery contract', () => {
  const base = {
    message: {
      id: 42,
      accountId: 'vitasci-outlook',
      providerMessageId: 'p-1',
      rawBlobHash: 'a'.repeat(64),
    },
    attachments: [
      {
        id: 7,
        fileName: 'invoice.pdf',
        blobHash: 'b'.repeat(64),
        securityStatus: 'safe',
      },
    ],
    destinations: ['financial-assistant', 'vitasci-crm'],
    triage: {
      categories: ['financial', 'vitasci'],
      confidence: 0.91,
      reason: 'invoice for VitaSci',
    },
  };

  test('creates a deterministic-shaped full-fidelity manifest', () => {
    const manifest = createDeliveryManifest(base);
    expect(validateDeliveryManifest(manifest).valid).toBe(true);
    expect(manifest.proposed_destinations).toEqual([
      'financial-assistant',
      'vitasci-crm',
    ]);
    expect(manifestDigest(manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects unscanned attachments', () => {
    const manifest = createDeliveryManifest({
      ...base,
      attachments: [{ ...base.attachments[0], securityStatus: 'unscanned' }],
    });
    expect(validateDeliveryManifest(manifest)).toEqual({
      valid: false,
      errors: ['attachment-not-safe:invoice.pdf'],
    });
  });
});
