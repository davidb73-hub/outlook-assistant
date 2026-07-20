const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

class OutlookMcpClient {
  constructor(config) {
    this.config = config;
    this.client = new Client(
      { name: 'outlook-local-triage-worker', version: '0.1.0' },
      { capabilities: {} }
    );
    this.transport = new StdioClientTransport({
      command: config.serverCommand,
      args: config.serverArgs,
      cwd: config.repoRoot,
      env: process.env,
      stderr: 'pipe',
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  callTool(name, args) {
    return this.client.callTool({ name, arguments: args });
  }

  async close() {
    await this.client.close();
  }
}

module.exports = {
  OutlookMcpClient,
};
