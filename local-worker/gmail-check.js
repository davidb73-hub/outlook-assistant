#!/usr/bin/env node
const fs = require('fs');
const { buildConfig } = require('./config');

function main() {
  const config = buildConfig();
  const accountKeys = Object.keys(config.gmail);

  if (accountKeys.length === 0) {
    console.log('No Gmail accounts configured.');
    return;
  }

  for (const accountKey of accountKeys) {
    const account = config.gmail[accountKey];
    const tokenExists = fs.existsSync(account.tokenPath);
    const token = tokenExists
      ? JSON.parse(fs.readFileSync(account.tokenPath, 'utf8'))
      : {};

    console.log(`Gmail account: ${accountKey}`);
    console.log(`  Provider id: ${account.id}`);
    console.log(`  Label: ${account.accountLabel}`);
    console.log(`  Client ID: ${account.clientId ? 'configured' : 'missing'}`);
    console.log(
      `  Client secret: ${account.clientSecret ? 'configured' : 'missing'}`
    );
    console.log(`  Redirect URI: ${account.redirectUri}`);
    console.log(`  Query: ${account.query}`);
    console.log(`  Token file: ${account.tokenPath}`);
    console.log(
      `  Refresh token: ${token.refresh_token ? 'present' : 'missing'}`
    );
    console.log('');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
