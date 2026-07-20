function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function headerMap(headers = []) {
  const result = new Map();
  for (const header of headers) {
    const key = String(header.name || '').toLowerCase();
    if (!key) continue;
    const values = result.get(key) || [];
    values.push(String(header.value || ''));
    result.set(key, values);
  }
  return result;
}

function parseAddresses(value, type) {
  if (!value) return [];
  return String(value)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, ordinal) => {
      const match = entry.match(/^(.*?)\s*<([^<>]+)>$/);
      if (!match) {
        return { type, ordinal, address: entry, displayName: '' };
      }
      return {
        type,
        ordinal,
        address: match[2].trim(),
        displayName: match[1].trim().replace(/^"|"$/g, ''),
      };
    });
}

function graphRecipient(recipient, type, ordinal = 0) {
  const email = recipient?.emailAddress || {};
  return {
    type,
    ordinal,
    address: email.address || '',
    displayName: email.name || '',
  };
}

function collectGmailParts(part, path = '0', result = null) {
  const output = result || { text: [], html: [], attachments: [] };
  if (!part) return output;
  const mediaType = String(part.mimeType || 'application/octet-stream');
  const data = part.body?.data ? decodeBase64Url(part.body.data) : null;

  if (mediaType === 'text/plain' && data && !part.filename) {
    output.text.push(data.toString('utf8'));
  } else if (mediaType === 'text/html' && data && !part.filename) {
    output.html.push(data.toString('utf8'));
  }

  if (part.filename) {
    const providerAttachmentId =
      part.body?.attachmentId || `inline-data:${path}`;
    output.attachments.push({
      providerAttachmentId,
      fileName: part.filename,
      mediaType,
      size: Number(part.body?.size) || data?.length || 0,
      contentId:
        (part.headers || []).find(
          (header) => header.name.toLowerCase() === 'content-id'
        )?.value || null,
      isInline:
        (part.headers || [])
          .find((header) => header.name.toLowerCase() === 'content-disposition')
          ?.value?.toLowerCase()
          .includes('inline') || false,
      inlineData: data,
    });
  }

  (part.parts || []).forEach((child, index) =>
    collectGmailParts(child, `${path}.${index}`, output)
  );
  return output;
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  collectGmailParts,
  decodeBase64Url,
  graphRecipient,
  headerMap,
  normalizedDate,
  parseAddresses,
};
