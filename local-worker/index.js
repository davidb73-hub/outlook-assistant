#!/usr/bin/env node
const { buildConfig } = require('./config');
const { OutlookMcpClient } = require('./mcp-client');
const { OllamaClient } = require('./ollama-client');
const { buildProviders } = require('./providers');
const { readState, writeState } = require('./state');
const { writeReports } = require('./report');
const { runTriage } = require('./triage');

async function main() {
  const config = buildConfig();
  const now = new Date();
  const state = await readState(config.statePath);
  const needsOutlook = config.providers.includes('outlook');
  const mcpClient = needsOutlook ? new OutlookMcpClient(config) : null;
  const ollamaClient = new OllamaClient({
    baseUrl: config.ollamaUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
  });

  try {
    if (mcpClient) await mcpClient.connect();
    const providers = buildProviders({ config, mcpClient });
    const result = await runTriage({
      providers,
      ollamaClient,
      state,
      now,
    });
    await writeState(config.statePath, result.nextState);
    const reports = await writeReports(config.reportsDir, result, now);
    console.log(`Local triage complete: ${reports.latestPath}`);
    console.log(
      `Processed ${result.emails.length} email(s), classified ${result.classifications.length}.`
    );
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Local triage failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
};
