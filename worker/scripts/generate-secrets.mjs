import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateVapidKeys } from '@mmmike/web-push/vapid';

const target = process.argv[2];
if (!target) throw new Error('Pass an output path outside the repository');
if (fs.existsSync(target)) throw new Error('Refusing to overwrite existing secrets');
const keys = await generateVapidKeys();
const values = {
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: 'https://neu-schedule-push-api.pages.dev/',
  ENROLLMENT_KEY: randomBytes(32).toString('base64url')
};
fs.writeFileSync(target, JSON.stringify(values, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Secrets written to ${target}; VAPID public key: ${values.VAPID_PUBLIC_KEY}`);
