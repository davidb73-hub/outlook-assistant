'use strict';

const {
  backupDisposable,
  finalizeDisposable,
  prepareDisposable,
  reconcileDisposable,
  rehearseRepair,
  restoreDisposable,
} = require('../disposable-commissioning');

const ACTIONS = Object.freeze({
  prepare_disposable: (input) =>
    prepareDisposable({
      sessionId: input.session_id,
      confirmation: input.confirmation,
    }),
  rehearse_repair: (input) =>
    rehearseRepair({
      sessionId: input.session_id,
      preparationCode: input.preparation_code,
    }),
  reconcile_disposable: (input) =>
    reconcileDisposable({
      sessionId: input.session_id,
      rehearsalCode: input.rehearsal_code,
    }),
  backup_disposable: (input) =>
    backupDisposable({
      sessionId: input.session_id,
      reconciliationCode: input.reconciliation_code,
    }),
  restore_disposable: (input) =>
    restoreDisposable({
      sessionId: input.session_id,
      backupCode: input.backup_code,
    }),
  finalize_disposable: (input) =>
    finalizeDisposable({
      sessionId: input.session_id,
      restoreCode: input.restore_code,
    }),
});

const ACTION_FIELDS = Object.freeze({
  prepare_disposable: Object.freeze(['confirmation', 'session_id']),
  rehearse_repair: Object.freeze(['preparation_code', 'session_id']),
  reconcile_disposable: Object.freeze(['rehearsal_code', 'session_id']),
  backup_disposable: Object.freeze(['reconciliation_code', 'session_id']),
  restore_disposable: Object.freeze(['backup_code', 'session_id']),
  finalize_disposable: Object.freeze(['restore_code', 'session_id']),
});

function objectInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('DISPOSABLE_COMMISSIONING_INPUT_INVALID');
    error.code = 'DISPOSABLE_COMMISSIONING_INPUT_INVALID';
    throw error;
  }
  return value;
}

function executeCloneCommissioningAction(action, input) {
  const handler = ACTIONS[action];
  if (!handler) {
    const error = new Error('DISPOSABLE_COMMISSIONING_ACTION_UNKNOWN');
    error.code = 'DISPOSABLE_COMMISSIONING_ACTION_UNKNOWN';
    throw error;
  }
  const validated = objectInput(input);
  const suppliedFields = Object.keys(validated).sort();
  if (
    JSON.stringify(suppliedFields) !== JSON.stringify(ACTION_FIELDS[action])
  ) {
    const error = new Error('DISPOSABLE_COMMISSIONING_INPUT_INVALID');
    error.code = 'DISPOSABLE_COMMISSIONING_INPUT_INVALID';
    throw error;
  }
  return handler(validated);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new Error('DISPOSABLE_COMMISSIONING_INPUT_INVALID');
  }
  const input = objectInput(JSON.parse(argv[1]));
  const result = await executeCloneCommissioningAction(argv[0], input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = String(error?.code || 'DISPOSABLE_COMMISSIONING_FAILED');
    process.stderr.write(
      `${code.startsWith('DISPOSABLE_COMMISSIONING_') ? code : 'DISPOSABLE_COMMISSIONING_FAILED'}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  ACTION_FIELDS,
  executeCloneCommissioningAction,
  objectInput,
};
