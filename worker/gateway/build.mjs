import { copyFile, cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const dist = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
await mkdir(dist, { recursive: true });
await copyFile(resolve(root, 'worker/gateway/src/_worker.js'), resolve(dist, '_worker.js'));
for (const name of ['index.html', 'app.js', 'gym-store.js', 'cloud-sync.js', 'bootstrap.js', 'auth-client.js', 'styles.css', 'sw.js', 'manifest.webmanifest']) {
  await copyFile(resolve(root, name), resolve(dist, name));
}
await cp(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });
await copyFile(resolve(root, 'worker/node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'), resolve(dist, 'webauthn-browser.js'));
await copyFile(resolve(root, 'worker/node_modules/@simplewebauthn/browser/LICENSE.md'), resolve(dist, 'webauthn-browser-LICENSE.md'));
console.log('Cloudflare Pages app assets built');
