const fs = require('fs/promises');
const path = require('path');

async function readState(statePath) {
  try {
    const text = await fs.readFile(statePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        deltaToken: null,
        processedMessageIds: [],
        providers: {},
        runs: [],
      };
    }
    throw error;
  }
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(`${statePath}.tmp`, statePath);
}

module.exports = {
  readState,
  writeState,
};
