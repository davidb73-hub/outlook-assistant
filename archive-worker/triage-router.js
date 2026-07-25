const FINANCIAL =
  /\b(invoice|bill|receipt|statement|tax|payment|quote|purchase order|remittance)\b/i;
const VITASCI = /\b(vitasci|vita sci|client|tender|project|crm|kms)\b/i;
// Narrowed on 2026-07-21. The previous pattern included "update" and "important",
// which every marketing email contains — six pieces of junk mail (a Temu delivery
// notice, a summer sale, reward points, CommSec marketing) were routed into the
// business vault as briefs. Keyword matching alone cannot tell a client update from
// a newsletter update.
const BRIEF =
  /\b(decision|deadline|action required|follow[- ]?up|agreed|proposal|contract|signed)\b/i;

// Bulk-mail signatures. Present in almost all marketing and transactional mail and
// almost never in genuine correspondence, so they are a cheap, high-precision veto.
const BULK_HEADERS = [
  'list-unsubscribe',
  'list-id',
  'precedence',
  'x-campaign-id',
  'feedback-id',
  'x-mailer-lid',
];
const BULK_SENDER =
  /\b(no-?reply|do-?not-?reply|notifications?|newsletter|marketing|alerts?|mailer|bounce|campaign)@/i;

/** Is this from someone we actually correspond with? */
function isKnownCorrespondent(message) {
  const known = (message.knownDomains || []).map((d) =>
    String(d).toLowerCase()
  );
  if (!known.length) return null; // caller supplied nothing — unknown, not false
  const from = String(message.fromAddress || message.from || '').toLowerCase();
  const domain = from.includes('@')
    ? from.split('@').pop().replace(/[>\s]/g, '')
    : '';
  return Boolean(domain && known.includes(domain));
}

/** Bulk/automated mail never belongs in a business brief. */
function looksLikeBulk(message) {
  const headers = message.headers || {};
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (BULK_HEADERS.some((h) => names.includes(h))) return true;
  const from = String(message.fromAddress || message.from || '').toLowerCase();
  return BULK_SENDER.test(from);
}

function classifyMessage(message) {
  const text = [message.subject, message.bodyText, message.bodyPreview]
    .filter(Boolean)
    .join('\n');
  const categories = [];
  const destinations = [];
  const known = isKnownCorrespondent(message);
  const bulk = looksLikeBulk(message);
  if (
    FINANCIAL.test(text) ||
    (message.attachments || []).some((a) =>
      /invoice|statement|receipt|bill/i.test(a.fileName || '')
    )
  ) {
    categories.push('financial');
    destinations.push('financial-assistant');
  }
  if (VITASCI.test(text) || message.accountId === 'vitasci-outlook') {
    categories.push('vitasci');
    destinations.push('vitasci-crm');
  }
  // A brief must be BOTH about something actionable AND from a real correspondent,
  // and never bulk mail. Who it is from is a far stronger signal than which words it
  // contains — the CRM already knows every client domain, so this needs no new data.
  if (BRIEF.test(text) && !bulk && known !== false) {
    categories.push('brief-candidate');
    destinations.push('hannibal-briefs');
  }

  let confidence = 0.65;
  if (destinations.length === 0) confidence = 0.2;
  else if (categories.length > 1) confidence = 0.75;
  // Confidence now reflects what we actually know rather than being a constant.
  if (known === true) confidence = Math.min(0.95, confidence + 0.2);
  if (known === null) confidence = Math.max(0.4, confidence - 0.15); // sender unverified
  if (bulk) confidence = Math.min(confidence, 0.3);
  return {
    categories,
    destinations: [...new Set(destinations)],
    confidence,
    disposition:
      destinations.length === 0 || confidence < 0.6 ? 'review' : 'proposed',
    reason: categories.length
      ? `matched: ${categories.join(', ')}`
      : 'no routing rule matched',
  };
}

module.exports = { classifyMessage };
