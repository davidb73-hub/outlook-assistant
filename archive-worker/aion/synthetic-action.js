'use strict';

const SYNTHETIC_MISMATCH = 'synthetic-mismatch';

function objectValue(value, field = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Synthetic ${field} must be an object`);
  }
  return value;
}

function required(value, field) {
  const record = objectValue(value);
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    throw new Error(`Synthetic input is missing required field '${field}'`);
  }
  return record[field];
}

function stringField(value, field) {
  const result = required(value, field);
  if (typeof result !== 'string') {
    throw new Error(`Synthetic field '${field}' must be a string`);
  }
  return result;
}

function booleanField(value, field) {
  const result = required(value, field);
  if (typeof result !== 'boolean') {
    throw new Error(`Synthetic field '${field}' must be a boolean`);
  }
  return result;
}

function integerField(value, field) {
  const result = required(value, field);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Synthetic field '${field}' must be an integer`);
  }
  return result;
}

function checkIdentity(input) {
  const account = objectValue(required(input, 'account'), 'account');
  const label = stringField(account, 'label');
  const provider = stringField(account, 'provider');
  const expected = stringField(account, 'expected_identity');
  const knownProvider = ['outlook', 'gmail'].includes(provider);
  const matched =
    knownProvider && expected.length > 0 && expected !== SYNTHETIC_MISMATCH;
  let observedIdentity = expected;
  if (expected === SYNTHETIC_MISMATCH) {
    observedIdentity = 'synthetic-observed-other';
  } else if (!expected) {
    observedIdentity = 'synthetic-observed-missing';
  }

  return {
    label,
    matched,
    observed_identity: observedIdentity,
    note: matched
      ? 'synthetic semantic identity matched'
      : 'synthetic semantic identity rejected',
  };
}

function assessIdentities(input) {
  const outlook = objectValue(required(input, 'outlook'), 'outlook');
  const workGmail = objectValue(required(input, 'work_gmail'), 'work_gmail');
  const personalGmail = objectValue(
    required(input, 'personal_gmail'),
    'personal_gmail'
  );
  const labels = [
    stringField(outlook, 'label'),
    stringField(workGmail, 'label'),
    stringField(personalGmail, 'label'),
  ];
  const allMatched = [outlook, workGmail, personalGmail].every((identity) =>
    booleanField(identity, 'matched')
  );
  const labelsAreDistinct =
    labels.every(Boolean) && new Set(labels).size === labels.length;
  const ok = allMatched && labelsAreDistinct;
  let reason = 'one or more synthetic identities did not match';
  if (ok) {
    reason = 'all three synthetic identities matched distinct account slots';
  } else if (allMatched) {
    reason = 'synthetic account labels must be non-empty and distinct';
  }

  return {
    ok,
    reason,
  };
}

function synchronize(input) {
  const account = objectValue(required(input, 'account'), 'account');
  const identity = objectValue(required(input, 'identity'), 'identity');
  const label = stringField(account, 'label');
  const matched = booleanField(identity, 'matched');

  if (!matched || label.includes('blocked')) {
    return {
      label,
      status: 'Blocked',
      checkpoint_advanced: false,
      discovered: 0,
      archived: 0,
      deferred: 0,
      note: 'synthetic synchronization blocked',
    };
  }
  if (label.includes('deferred')) {
    return {
      label,
      status: 'Deferred',
      checkpoint_advanced: false,
      discovered: 3,
      archived: 2,
      deferred: 1,
      note: 'synthetic synchronization left one item deferred',
    };
  }
  return {
    label,
    status: 'Synchronized',
    checkpoint_advanced: true,
    discovered: 3,
    archived: 3,
    deferred: 0,
    note: 'synthetic synchronization completed',
  };
}

function reconcile(input) {
  const reports = ['outlook', 'work_gmail', 'personal_gmail'].map((field) =>
    objectValue(required(input, field), field)
  );
  const blocked = reports.filter(
    (report) => stringField(report, 'status') === 'Blocked'
  ).length;
  const deferredItems = reports.reduce(
    (total, report) => total + integerField(report, 'deferred'),
    0
  );
  let reason = 'synthetic reconciliation found no discrepancies';
  if (blocked > 0) {
    reason = 'synthetic reconciliation found blocked account synchronizations';
  } else if (deferredItems > 0) {
    reason = 'synthetic reconciliation completed with deferred items';
  }

  return {
    ok: blocked === 0,
    compared_accounts: 3,
    missing_messages: blocked,
    missing_attachments: 0,
    discrepancies: blocked,
    deferred_items: deferredItems,
    reason,
  };
}

function verifyIntegrity(input) {
  const reconciliation = objectValue(
    required(input, 'reconciliation'),
    'reconciliation'
  );
  const discrepancies = integerField(reconciliation, 'discrepancies');
  const ok = booleanField(reconciliation, 'ok') && discrepancies === 0;

  return {
    ok,
    checked_records: 9,
    invalid_records: ok ? 0 : Math.max(discrepancies, 1),
    reason: ok
      ? 'synthetic archive invariants and hashes verified'
      : 'synthetic integrity verification rejected discrepancies',
  };
}

function createBackup(input) {
  const integrity = objectValue(required(input, 'integrity'), 'integrity');
  const ok = booleanField(integrity, 'ok');
  const checkedRecords = integerField(integrity, 'checked_records');

  return ok
    ? {
        ok: true,
        snapshot_id: `synthetic-snapshot-${checkedRecords}`,
        verified: true,
        reason: 'synthetic in-memory backup receipt verified',
      }
    : {
        ok: false,
        snapshot_id: '',
        verified: false,
        reason: 'synthetic backup refused an invalid archive',
      };
}

function summarizeSuccess(input) {
  for (const field of ['outlook', 'work_gmail', 'personal_gmail']) {
    stringField(objectValue(required(input, field), field), 'status');
  }
  const reconciliation = objectValue(
    required(input, 'reconciliation'),
    'reconciliation'
  );
  const backup = objectValue(required(input, 'backup'), 'backup');

  return {
    status: 'completed',
    phase: 'complete',
    summary:
      'three synthetic accounts synchronized, reconciled, verified, and backed up',
    accounts_checked: 3,
    accounts_synchronized: 3,
    discrepancies: integerField(reconciliation, 'discrepancies'),
    backup_snapshot: stringField(backup, 'snapshot_id'),
  };
}

function summarizeFailure(input) {
  const phase = stringField(input, 'phase');
  const reason = stringField(input, 'reason');
  return {
    status: 'failed',
    phase,
    summary: `synthetic ${phase} failure: ${reason}`,
    accounts_checked: 3,
    accounts_synchronized: phase === 'identity' ? 0 : 3,
    discrepancies: 0,
    backup_snapshot: '',
  };
}

const ACTIONS = Object.freeze({
  check_identity: checkIdentity,
  assess_identities: assessIdentities,
  synchronize,
  reconcile,
  verify_integrity: verifyIntegrity,
  create_backup: createBackup,
  summarize_success: summarizeSuccess,
  summarize_failure: summarizeFailure,
});

function executeSyntheticAction(action, input) {
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`Unknown synthetic action '${action}'`);
  return handler(objectValue(input));
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new Error('Expected: synthetic-action.js <action> <json-input>');
  }
  const input = JSON.parse(argv[1]);
  process.stdout.write(
    `${JSON.stringify(executeSyntheticAction(argv[0], input))}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Synthetic action failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SYNTHETIC_MISMATCH,
  executeSyntheticAction,
};
