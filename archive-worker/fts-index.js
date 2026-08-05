const FTS_ACCOUNT_UPDATE_SQL = `UPDATE messages_fts
 SET account_id = ?
 WHERE rowid = ? AND message_id = ? AND account_id IS ?`;

const FTS_ROW_DELETE_SQL = `DELETE FROM messages_fts
 WHERE rowid = ? AND message_id = ?`;

function messageKey(value) {
  return String(value);
}

function scanFtsIndex(database) {
  const db = database?.db || database;
  const rows = db
    .prepare(
      `SELECT rowid AS fts_rowid, message_id, account_id
       FROM messages_fts
       ORDER BY rowid`
    )
    .all();
  const rowsByMessageId = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = messageKey(row.message_id);
    if (rowsByMessageId.has(key)) duplicateRows += 1;
    else rowsByMessageId.set(key, row);
  }
  return { rows, rowsByMessageId, duplicateRows };
}

function inspectFtsConsistency(database) {
  const db = database?.db || database;
  const index = scanFtsIndex(db);
  const messages = db
    .prepare('SELECT id, account_id FROM messages ORDER BY id')
    .all();
  const messagesById = new Map(
    messages.map((message) => [messageKey(message.id), message])
  );
  let accountMismatches = 0;
  let orphanRows = 0;
  for (const row of index.rows) {
    const message = messagesById.get(messageKey(row.message_id));
    if (!message) orphanRows += 1;
    else if (row.account_id !== message.account_id) accountMismatches += 1;
  }
  let missingRows = 0;
  for (const message of messages) {
    if (!index.rowsByMessageId.has(messageKey(message.id))) missingRows += 1;
  }
  const summary = {
    accountMismatches,
    missingRows,
    orphanRows,
    duplicateRows: index.duplicateRows,
    messageRows: messages.length,
    ftsRows: index.rows.length,
  };
  return {
    ...index,
    summary: {
      ...summary,
      passed:
        summary.accountMismatches === 0 &&
        summary.missingRows === 0 &&
        summary.orphanRows === 0 &&
        summary.duplicateRows === 0,
    },
  };
}

module.exports = {
  FTS_ACCOUNT_UPDATE_SQL,
  FTS_ROW_DELETE_SQL,
  inspectFtsConsistency,
  messageKey,
  scanFtsIndex,
};
