const fs = require('fs/promises');
const path = require('path');

const PRIORITY_ORDER = ['urgent', 'needs_reply', 'waiting', 'fyi', 'noise'];
const PRIORITY_LABELS = {
  urgent: 'Urgent',
  needs_reply: 'Needs Reply',
  waiting: 'Waiting',
  fyi: 'FYI',
  noise: 'Noise',
};

function safeTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function renderMarkdownReport(result) {
  const lines = [
    '# Local Inbox Triage Report',
    '',
    `Generated: ${result.startedAt}`,
    `Providers: ${result.providers.map((provider) => provider.label).join(', ')}`,
    `Model: ${result.model || 'not run - no new emails'}`,
    `Emails processed: ${result.emails.length}`,
    '',
  ];

  const resetProviders = result.providers.filter(
    (provider) => provider.meta?.resetDelta
  );
  if (resetProviders.length > 0) {
    lines.push(
      `> Delta token reset: ${resetProviders.map((provider) => provider.label).join(', ')}`,
      ''
    );
  }

  if (result.classifications.length === 0) {
    lines.push('No new emails required triage.', '');
    return lines.join('\n');
  }

  for (const priority of PRIORITY_ORDER) {
    const group = result.classifications.filter(
      (item) => item.priority === priority
    );
    if (group.length === 0) continue;

    lines.push(`## ${PRIORITY_LABELS[priority]}`, '');
    for (const item of group) {
      const email = result.emails.find(
        (candidate) => candidate.messageId === item.messageId
      );
      lines.push(
        `- **[${email?.providerLabel || 'Unknown'}] ${email?.subject || '(no subject)'}**`
      );
      lines.push(`  - From: ${email?.from || 'unknown'}`);
      lines.push(`  - Reason: ${item.reason || 'No reason provided'}`);
      lines.push(
        `  - Suggested action: ${item.suggestedAction || 'No action suggested'}`
      );
      lines.push(`  - Confidence: ${item.confidence}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeReports(reportsDir, result, now) {
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = safeTimestamp(now);
  const markdown = renderMarkdownReport(result);
  const json = JSON.stringify(
    {
      startedAt: result.startedAt,
      providers: result.providers,
      model: result.model,
      classifications: result.classifications,
      rawModelOutput: result.rawModelOutput,
    },
    null,
    2
  );

  const markdownPath = path.join(reportsDir, `${stamp}.md`);
  const jsonPath = path.join(reportsDir, `${stamp}.json`);
  const latestPath = path.join(reportsDir, 'latest.md');

  await fs.writeFile(markdownPath, markdown);
  await fs.writeFile(jsonPath, `${json}\n`);
  await fs.writeFile(latestPath, markdown);

  return {
    markdownPath,
    jsonPath,
    latestPath,
  };
}

module.exports = {
  renderMarkdownReport,
  safeTimestamp,
  writeReports,
};
