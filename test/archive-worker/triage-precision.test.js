const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const { classifyMessage } = require('../../archive-worker/triage-router');

// Regression tests for 2026-07-21. Six pieces of junk mail reached the business vault
// as "briefs" because the keyword list included "update" and "important" — words every
// marketing email contains. These are the actual messages that got through, verbatim.

const KNOWN = ['actcurious.com', 'sydney.edu.au', 'chemotrak.com'];

const junk = (subject, from, extra = {}) => ({
  accountId: 'gmail-personal',
  subject,
  fromAddress: from,
  bodyText: '',
  attachments: [],
  knownDomains: KNOWN,
  ...extra,
});

describe('brief routing rejects bulk and unknown senders', () => {
  const cases = [
    [
      'Your Temu order has been transferred to Australia Post for delivery',
      'no-reply@temuofficial.com',
    ],
    ['The Aussie summer sale is on now', 'marketing@retailer.com.au'],
    ['David, you have Altitude reward points', 'notifications@points.com.au'],
    [
      "David, we're making CommSec simpler and more secure",
      'no-reply@commsec.com.au',
    ],
    [
      'Get 100% back on popular extras such as dental and optical',
      'newsletter@health.com.au',
    ],
    ['Security alert', 'no-reply@accounts.google.com'],
  ];

  test.each(cases)('does not route %s to the vault', (subject, from) => {
    const r = classifyMessage(junk(subject, from));
    expect(r.destinations).not.toContain('hannibal-briefs');
  });

  test('bulk headers alone are enough to veto', () => {
    const r = classifyMessage(
      junk('Deadline for your proposal', 'someone@unknown-vendor.com', {
        headers: { 'List-Unsubscribe': '<mailto:x@y.com>' },
      })
    );
    expect(r.destinations).not.toContain('hannibal-briefs');
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe('genuine client correspondence still routes', () => {
  test('a real client email with an actionable subject is briefed', () => {
    const r = classifyMessage(
      junk(
        'Deadline for the tender proposal — please confirm',
        'indi@actcurious.com'
      )
    );
    expect(r.destinations).toContain('hannibal-briefs');
    expect(r.disposition).toBe('proposed');
  });

  test('a known correspondent raises confidence', () => {
    const known = classifyMessage(
      junk('Decision on the contract', 'geoff@sydney.edu.au')
    );
    const unknown = classifyMessage(
      junk('Decision on the contract', 'geoff@example.org')
    );
    expect(known.confidence).toBeGreaterThan(unknown.confidence);
  });

  test('an unverified sender is allowed through but with lower confidence', () => {
    // knownDomains absent — the caller could not tell us. Unknown must not mean
    // rejected, or the first email from a new client would be silently dropped.
    const r = classifyMessage({
      accountId: 'vitasci-outlook',
      subject: 'Contract signed — next steps',
      fromAddress: 'new.client@somewhere.com',
      bodyText: '',
      attachments: [],
    });
    expect(r.destinations).toContain('hannibal-briefs');
    expect(r.confidence).toBeLessThan(0.65);
  });
});

describe('other destinations are unaffected', () => {
  test('financial routing still works for bulk senders', () => {
    const r = classifyMessage(
      junk('Your invoice is ready', 'billing@supplier.com', {
        attachments: [{ fileName: 'invoice.pdf' }],
      })
    );
    expect(r.destinations).toContain('financial-assistant');
  });

  test('vitasci account mail still routes to the CRM', () => {
    const r = classifyMessage({
      accountId: 'vitasci-outlook',
      subject: 'Anything at all',
      fromAddress: 'someone@elsewhere.com',
      bodyText: '',
      attachments: [],
      knownDomains: KNOWN,
    });
    expect(r.destinations).toContain('vitasci-crm');
  });
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-correspondent-'));
  return { db: new ArchiveDatabase(path.join(dir, 'archive.sqlite3')), dir };
}

describe('known-correspondent evidence comes from outbound mail', () => {
  let ctx;

  beforeEach(() => {
    ctx = tempDb();
  });

  afterEach(() => {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  function seed({ direction, address, type = 'to' }) {
    ctx.db.upsertAccount({
      id: 'acct',
      provider: 'outlook',
      displayName: 'Fixture Account',
    });
    const now = new Date().toISOString();
    const message = ctx.db.db
      .prepare(
        `INSERT INTO messages (
           account_id, provider_message_id, direction, archive_state,
           first_archived_at, last_seen_at, updated_at
         ) VALUES ('acct', ?, ?, 'archived_complete', ?, ?, ?)`
      )
      .run(`message-${Math.random()}`, direction, now, now, now);
    ctx.db.db
      .prepare(
        `INSERT INTO recipients (
           message_id, recipient_type, ordinal, address
         ) VALUES (?, ?, 0, ?)`
      )
      .run(message.lastInsertRowid, type, address);
  }

  test('a domain previously sent to is known', () => {
    seed({ direction: 'outbound', address: 'contact@clientco.example' });
    expect(ctx.db.getKnownDomains()).toContain('clientco.example');
  });

  test('a domain seen only on inbound mail is not treated as known', () => {
    seed({ direction: 'inbound', address: 'owner@vitasci.example' });
    expect(ctx.db.getKnownDomains()).not.toContain('vitasci.example');
  });

  test('an empty archive produces an empty domain list', () => {
    expect(ctx.db.getKnownDomains()).toEqual([]);
  });

  test('the derived domain list is cached for the routing cycle', () => {
    seed({ direction: 'outbound', address: 'one@first.example' });
    const first = ctx.db.getKnownDomains();
    seed({ direction: 'outbound', address: 'two@second.example' });
    expect(ctx.db.getKnownDomains()).toBe(first);
  });
});
