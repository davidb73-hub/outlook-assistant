const FINANCIAL =
  /\b(invoice|bill|receipt|statement|tax|payment|quote|purchase order|remittance)\b/i;
const VITASCI = /\b(vitasci|vita sci|client|tender|project|crm|kms)\b/i;
const BRIEF =
  /\b(decision|deadline|action required|meeting|important|brief|update|follow[- ]?up)\b/i;

function classifyMessage(message) {
  const text = [message.subject, message.bodyText, message.bodyPreview]
    .filter(Boolean)
    .join('\n');
  const categories = [];
  const destinations = [];
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
  if (BRIEF.test(text)) {
    categories.push('brief-candidate');
    destinations.push('hannibal-briefs');
  }
  let confidence = 0.65;
  if (destinations.length === 0) confidence = 0.2;
  else if (categories.length > 1) confidence = 0.75;
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
