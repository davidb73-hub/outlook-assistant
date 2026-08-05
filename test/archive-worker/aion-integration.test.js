const {
  executeSyntheticAction,
} = require('../../archive-worker/aion/synthetic-action');
const {
  CONFIRMATION,
  executeIdentityPreflight,
  parseInput,
} = require('../../archive-worker/aion/identity-preflight-action');
const syntheticInput = require('../../archive-worker/aion/synthetic-input.json');
const {
  COMMISSIONING_CONFIRMATION,
  cleanupDisposable,
} = require('../../archive-worker/disposable-commissioning');
const {
  executeCloneCommissioningAction,
} = require('../../archive-worker/aion/clone-commissioning-action');

function runSyntheticCycle(fixture = syntheticInput) {
  const {
    outlook,
    work_gmail: workGmail,
    personal_gmail: personalGmail,
  } = fixture.accounts;
  const outlookIdentity = executeSyntheticAction('check_identity', {
    account: outlook,
  });
  const workIdentity = executeSyntheticAction('check_identity', {
    account: workGmail,
  });
  const personalIdentity = executeSyntheticAction('check_identity', {
    account: personalGmail,
  });
  const assessment = executeSyntheticAction('assess_identities', {
    outlook: outlookIdentity,
    work_gmail: workIdentity,
    personal_gmail: personalIdentity,
  });
  const outlookSync = executeSyntheticAction('synchronize', {
    account: outlook,
    identity: outlookIdentity,
  });
  const workSync = executeSyntheticAction('synchronize', {
    account: workGmail,
    identity: workIdentity,
  });
  const personalSync = executeSyntheticAction('synchronize', {
    account: personalGmail,
    identity: personalIdentity,
  });
  const reconciliation = executeSyntheticAction('reconcile', {
    outlook: outlookSync,
    work_gmail: workSync,
    personal_gmail: personalSync,
  });
  const integrity = executeSyntheticAction('verify_integrity', {
    reconciliation,
  });
  const backup = executeSyntheticAction('create_backup', { integrity });
  const summary = executeSyntheticAction('summarize_success', {
    outlook: outlookSync,
    work_gmail: workSync,
    personal_gmail: personalSync,
    reconciliation,
    integrity,
    backup,
  });
  return { assessment, reconciliation, integrity, backup, summary };
}

describe('Aion email archive integration', () => {
  test('runs the complete synthetic activity chain without external access', () => {
    const result = runSyntheticCycle();

    expect(result.assessment.ok).toBe(true);
    expect(result.reconciliation).toMatchObject({
      ok: true,
      discrepancies: 0,
    });
    expect(result.integrity.ok).toBe(true);
    expect(result.backup).toMatchObject({
      ok: true,
      verified: true,
      snapshot_id: 'synthetic-snapshot-9',
    });
    expect(result.summary).toMatchObject({
      status: 'completed',
      accounts_synchronized: 3,
      backup_snapshot: 'synthetic-snapshot-9',
    });
  });

  test('keeps synthetic identity rejection fail-closed', () => {
    const rejected = executeSyntheticAction('check_identity', {
      account: {
        label: 'outlook',
        provider: 'outlook',
        expected_identity: 'synthetic-mismatch',
      },
    });

    expect(rejected.matched).toBe(false);
  });

  test('requires the exact non-secret live-preflight acknowledgement', () => {
    expect(() => parseInput(JSON.stringify({ confirmation: 'wrong' }))).toThrow(
      'IDENTITY_PREFLIGHT_CONFIRMATION_REQUIRED'
    );
    expect(() =>
      parseInput(
        JSON.stringify({ confirmation: CONFIRMATION, unexpected: true })
      )
    ).toThrow('IDENTITY_PREFLIGHT_CONFIRMATION_REQUIRED');
  });

  test('returns only sanitized provider identity evidence', async () => {
    const statusBuilder = jest.fn(() =>
      Promise.resolve({
        generatedAt: '2026-08-05T00:00:00.000Z',
        passed: true,
        accounts: ['vitasci-outlook', 'gmail-ablative', 'gmail-personal'].map(
          (logicalAccountId, index) => ({
            logicalAccountId,
            credentialSlot: `slot-${index + 1}`,
            expectedIdentityConfigured: true,
            identityMatch: true,
            verifiedAt: '2026-08-05T00:00:00.000Z',
            errorCode: null,
          })
        ),
      })
    );
    const result = await executeIdentityPreflight(
      { confirmation: CONFIRMATION },
      {
        env: {},
        configBuilder: () => ({ accounts: [] }),
        statusBuilder,
      }
    );

    expect(result).toMatchObject({
      passed: true,
      archive_opened: false,
      credentials_persisted: false,
    });
    expect(result.accounts).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('@');
  });

  test('cannot report ready without all three proved accounts', async () => {
    const result = await executeIdentityPreflight(
      { confirmation: CONFIRMATION },
      {
        env: {},
        configBuilder: () => ({ accounts: [] }),
        statusBuilder: () =>
          Promise.resolve({
            generatedAt: '2026-08-05T00:00:00.000Z',
            passed: true,
            accounts: [],
          }),
      }
    );

    expect(result.passed).toBe(false);
  });

  test('keeps disposable commissioning behind exact inputs', async () => {
    await expect(
      executeCloneCommissioningAction('prepare_disposable', {
        session_id: 'commissioning-input-test',
        confirmation: 'wrong',
      })
    ).rejects.toThrow('DISPOSABLE_COMMISSIONING_CONFIRMATION_REQUIRED');
    expect(() =>
      executeCloneCommissioningAction('prepare_disposable', {
        session_id: 'commissioning-input-test',
        confirmation: COMMISSIONING_CONFIRMATION,
        unexpected: true,
      })
    ).toThrow('DISPOSABLE_COMMISSIONING_INPUT_INVALID');
    expect(() => executeCloneCommissioningAction('unknown', {})).toThrow(
      'DISPOSABLE_COMMISSIONING_ACTION_UNKNOWN'
    );
  });

  test('commissions the real archive machinery against a disposable clone', async () => {
    const sessionId = `jest-${Date.now()}-${process.pid}`;
    try {
      const prepared = await executeCloneCommissioningAction(
        'prepare_disposable',
        {
          session_id: sessionId,
          confirmation: COMMISSIONING_CONFIRMATION,
        }
      );
      const repaired = await executeCloneCommissioningAction(
        'rehearse_repair',
        {
          session_id: sessionId,
          preparation_code: prepared.code,
        }
      );
      const reconciled = await executeCloneCommissioningAction(
        'reconcile_disposable',
        {
          session_id: sessionId,
          rehearsal_code: repaired.code,
        }
      );
      const backedUp = await executeCloneCommissioningAction(
        'backup_disposable',
        {
          session_id: sessionId,
          reconciliation_code: reconciled.code,
        }
      );
      const restored = await executeCloneCommissioningAction(
        'restore_disposable',
        {
          session_id: sessionId,
          backup_code: backedUp.code,
        }
      );
      const summary = await executeCloneCommissioningAction(
        'finalize_disposable',
        {
          session_id: sessionId,
          restore_code: restored.code,
        }
      );

      expect(repaired).toMatchObject({
        ok: true,
        second_run_noop: true,
      });
      expect(reconciled).toMatchObject({
        ok: true,
        accounts_reconciled: 3,
        differences: 0,
        integrity_ok: true,
      });
      expect(backedUp).toMatchObject({
        ok: true,
        snapshots_created: 2,
        deduplication_observed: true,
      });
      expect(restored).toMatchObject({
        ok: true,
        database_hash_matches: true,
        counts_match: true,
      });
      expect(summary).toMatchObject({
        status: 'commissioned_disposable',
        live_archive_unchanged: true,
        live_email_retrieved: false,
      });
    } finally {
      await cleanupDisposable({
        sessionId,
        confirmation: COMMISSIONING_CONFIRMATION,
      }).catch(() => {});
    }
  }, 60_000);
});
