// Prints the extension ID derived from the "key" in extension/manifest.json.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (!manifest.key) {
  console.error('extension/manifest.json has no "key"');
  process.exit(1);
}
const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
process.stdout.write([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
