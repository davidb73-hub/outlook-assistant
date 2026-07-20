#!/usr/bin/env node
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { buildConfig } = require('./config');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

async function main() {
  const accountKey = process.argv[2] || 'ablative';
  const allConfig = buildConfig();
  const config = allConfig.gmail[accountKey];
  if (!config) {
    throw new Error(
      `Unknown Gmail account '${accountKey}'. Add it to LOCAL_TRIAGE_GMAIL_ACCOUNTS.`
    );
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      `Set ${accountKey === 'ablative' ? 'GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET or ' : ''}GMAIL_${accountKey.toUpperCase()}_CLIENT_ID and GMAIL_${accountKey.toUpperCase()}_CLIENT_SECRET first.`
    );
  }

  const authUrl = buildAuthUrl(config);
  console.log('Open this URL and approve read-only Gmail access:');
  console.log(authUrl);
  console.log('');
  console.log(`Waiting for callback on ${config.redirectUri}`);

  const code = await waitForCode(config.redirectUri);
  const token = await exchangeCode(config, code);
  await writeToken(config.tokenPath, token);
  console.log(
    `Gmail token saved for ${config.accountLabel}: ${config.tokenPath}`
  );
}

function buildAuthUrl(config) {
  return `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  })}`;
}

function waitForCode(redirectUri) {
  const url = new URL(redirectUri);
  const port = Number(url.port || 80);
  const expectedPath = url.pathname;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, redirectUri);
      if (requestUrl.pathname !== expectedPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      if (error) {
        res.writeHead(400);
        res.end(`Gmail auth failed: ${error}`);
        server.close();
        reject(new Error(`Gmail auth failed: ${error}`));
        return;
      }

      const code = requestUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Gmail read-only auth complete. You can close this tab.');
      server.close();
      resolve(code);
    });

    server.once('error', reject);
    server.listen(port, url.hostname);
  });
}

async function exchangeCode(config, code) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`Gmail code exchange failed: ${response.status}`);
  }

  const token = await response.json();
  return {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: Date.now() + token.expires_in * 1000,
    scope: token.scope,
    token_type: token.token_type,
  };
}

async function writeToken(tokenPath, token) {
  if (!token.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Re-run auth with prompt=consent or revoke the app and try again.'
    );
  }
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Gmail auth failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
};
