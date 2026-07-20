const ACCOUNT_ID_PAIRS = Object.freeze({
  'gmail-ablative': 'gmail-personal',
  'gmail-personal': 'gmail-ablative',
});

const ACCOUNT_ID_TABLES = [
  'folders',
  'messages',
  'sync_cursors',
  'ingestion_runs',
  'ingestion_errors',
  'messages_fts',
];

function remapGmailIdentityIds(database) {
  const temporaryIds = {
    'gmail-ablative': '__identity_swap_gmail_ablative',
    'gmail-personal': '__identity_swap_gmail_personal',
  };
  const remap = database.db.transaction(() => {
    database.db.pragma('defer_foreign_keys = ON');

    for (const [source, temporary] of Object.entries(temporaryIds)) {
      database.db
        .prepare('UPDATE accounts SET id = ? WHERE id = ?')
        .run(temporary, source);
    }
    for (const table of ACCOUNT_ID_TABLES) {
      for (const [source, temporary] of Object.entries(temporaryIds)) {
        database.db
          .prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`)
          .run(temporary, source);
      }
    }
    for (const [source, temporary] of Object.entries(temporaryIds)) {
      database.db
        .prepare('UPDATE accounts SET id = ? WHERE id = ?')
        .run(ACCOUNT_ID_PAIRS[source], temporary);
    }
    for (const [source, temporary] of Object.entries(temporaryIds)) {
      database.db
        .prepare(
          `UPDATE ${ACCOUNT_ID_TABLES[0]} SET account_id = ? WHERE account_id = ?`
        )
        .run(ACCOUNT_ID_PAIRS[source], temporary);
    }
    for (const table of ACCOUNT_ID_TABLES.slice(1)) {
      for (const [source, temporary] of Object.entries(temporaryIds)) {
        database.db
          .prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`)
          .run(ACCOUNT_ID_PAIRS[source], temporary);
      }
    }

    const foreignKeyProblems = database.db.pragma('foreign_key_check');
    if (foreignKeyProblems.length > 0) {
      throw new Error(
        `Gmail identity remap produced ${foreignKeyProblems.length} foreign-key problems`
      );
    }
    return {
      swapped: Object.keys(ACCOUNT_ID_PAIRS),
      foreignKeyProblems: foreignKeyProblems.length,
    };
  });
  return remap();
}

module.exports = {
  ACCOUNT_ID_PAIRS,
  ACCOUNT_ID_TABLES,
  remapGmailIdentityIds,
};
