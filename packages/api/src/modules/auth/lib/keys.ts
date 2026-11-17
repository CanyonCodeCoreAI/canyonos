// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { importSPKI } from 'jose';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The names in `dir` to read as keys, the ones the CLI reads too: every `*.pub` file,
 * followed through symlinks (a Kubernetes ConfigMap volume is symlinks into `..data/`), whose
 * name does not start with `.`. Anything else, such as a README, is not a key and is left. */
async function keyFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(`AUTH_TRUSTED_KEYS_DIR ${dir} cannot be read: ${describe(error)}`);
  }
  const files: string[] = [];
  const keys = names.filter((entry) => !entry.startsWith('.') && entry.endsWith('.pub'));
  for (const name of keys.sort()) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).isFile()) files.push(path);
    } catch (error) {
      throw new Error(`AUTH_TRUSTED_KEYS_DIR ${dir}: ${path} cannot be read: ${describe(error)}`);
    }
  }
  return files;
}

async function importKey(dir: string, path: string): Promise<CryptoKey> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`AUTH_TRUSTED_KEYS_DIR ${dir}: ${path} cannot be read: ${describe(error)}`);
  }
  try {
    return await importSPKI(pem.trim(), 'EdDSA');
  } catch (error) {
    throw new Error(
      `AUTH_TRUSTED_KEYS_DIR ${dir}: ${path} is not an Ed25519 public key in PEM ` +
        `(\`canyonos keys create\` makes one): ${describe(error)}`
    );
  }
}

/** The public keys a token may be signed by, read once at startup: changing them means
 * restarting the API. Throws naming `AUTH_TRUSTED_KEYS_DIR` and the path at fault. */
export async function loadTrustedKeys(dir: string): Promise<CryptoKey[]> {
  const files = await keyFiles(dir);
  return Promise.all(files.map((path) => importKey(dir, path)));
}
