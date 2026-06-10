/**
 * Telegram MTProto Auth Script
 * Run: node scripts/tg-auth.cjs
 * 
 * Generates session string for channel monitoring.
 * Requires: api_id, api_hash from https://my.telegram.org
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('=== Telegram MTProto Auth ===\n');
  console.log('Get api_id/api_hash from: https://my.telegram.org\n');

  const apiId = parseInt(await ask('API ID: '), 10);
  const apiHash = await ask('API Hash: ');
  const phoneNumber = await ask('Phone (e.g. +6281513753482): ');

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => await ask('2FA Password (if any, or press Enter): '),
    phoneCode: async () => await ask('OTP Code: '),
    onError: (err) => console.error('Auth error:', err.message),
  });

  const sessionString = client.session.save();
  console.log('\n=== Session String ===');
  console.log(sessionString);
  console.log('\nAdd to .env:');
  console.log(`TG_API_ID=${apiId}`);
  console.log(`TG_API_HASH=${apiHash}`);
  console.log(`TG_SESSION_STRING=${sessionString}`);

  // Auto-append to .env
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  
  if (!envContent.includes('TG_API_ID')) {
    fs.appendFileSync(envPath, `\n\n# Telegram MTProto (channel monitor)\nTG_API_ID=${apiId}\nTG_API_HASH=${apiHash}\nTG_SESSION_STRING=${sessionString}\n`);
    console.log('\n[OK] Saved to .env');
  } else {
    console.log('\n[SKIP] .env already has TG_API_ID. Update manually.');
  }

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
