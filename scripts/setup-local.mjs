import fs from 'node:fs';
import crypto from 'node:crypto';
if (fs.existsSync('.env')) throw new Error('.env already exists; edit it directly. No credentials overwritten.');
let content = fs.readFileSync('.env.example', 'utf8')
  .replace(/^NODE_ENV=.*$/m, 'NODE_ENV=development')
  .replace(/^SYSTEM_OPERATING_MODE=.*$/m, 'SYSTEM_OPERATING_MODE=SIMULATION')
  .replace(/^PGHOST=.*$/m, 'PGHOST=127.0.0.1')
  .replace(/^APP_URL=.*$/m, 'APP_URL=http://localhost:3000');
for (const key of ['API_AUTH_TOKEN', 'OWNER_API_KEY', 'OWNER_OVERRIDE_KEY', 'PGPASSWORD', 'V13_BRIDGE_TOKEN']) {
  content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${crypto.randomBytes(32).toString('hex')}`);
}
fs.writeFileSync('.env', content, { mode: 0o600, flag: 'wx' });
console.log('Created .env with independent local secrets. Open it locally and use OWNER_API_KEY on the sign-in screen. No credentials were printed.');
