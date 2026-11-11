// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { config } from '@core/env';
import { internalError } from '@core/errors';

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const key = createHash('sha256').update(config.canyonos.redisPasswordKey).digest();

/** Encrypts a project's Redis password for the database, as `v1:<iv>:<auth tag>:<ciphertext>`
 * in base64, with a new random IV each time. */
export function seal_redis_password(password: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64'));
  return [FORMAT_VERSION, ...parts].join(':');
}

function unreadable(cause: unknown) {
  return internalError(
    'canyonos.redis_password_unreadable',
    "The dashboard can't decrypt the Redis password it stored for this project; its REDIS_PASSWORD_ENCRYPTION_KEY may have changed since. Deploy the project again with `canyonos deploy` to register it again.",
    { cause }
  );
}

/** Decrypts a password seal_redis_password stored. A value this key cannot open (another key,
 * or stored before passwords were encrypted) fails that project's request with a clear error. */
export function open_redis_password(sealed: string): string {
  const [version, iv, tag, ciphertext, ...rest] = sealed.split(':');
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined || rest.length) {
    throw unreadable(new Error(`not a ${FORMAT_VERSION} sealed Redis password`));
  }
  const auth_tag = Buffer.from(tag, 'base64');
  if (auth_tag.length !== AUTH_TAG_BYTES) {
    throw unreadable(new Error(`its auth tag is not ${AUTH_TAG_BYTES} bytes`));
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(auth_tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw unreadable(error);
  }
}
