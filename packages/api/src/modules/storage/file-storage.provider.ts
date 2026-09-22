import { createHash } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A content-addressed byte store: blobs are keyed by the sha256 of their bytes. */
export interface BlobStore {
  /** Store `content` and return its content hash. Re-storing the same bytes is a no-op. */
  put(content: string): Promise<string>;
  /** The stored bytes for `content_hash`, or null when no blob exists for it. */
  get(content_hash: string): Promise<string | null>;
  exists(content_hash: string): Promise<boolean>;
  delete(content_hash: string): Promise<void>;
}

export function hash_content(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** A `BlobStore` over a local directory: blobs at `<root>/<ab>/<hash>`, written temp-then-rename. */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path_for(content_hash: string): string {
    return join(this.root, content_hash.slice(0, 2), content_hash);
  }

  async put(content: string): Promise<string> {
    const content_hash = hash_content(content);
    const target = this.path_for(content_hash);
    if (await this.exists(content_hash)) return content_hash;

    await mkdir(dirname(target), { recursive: true });
    const staging = `${target}.${Bun.randomUUIDv7()}.tmp`;
    await Bun.write(staging, content);
    await rename(staging, target);
    return content_hash;
  }

  async get(content_hash: string): Promise<string | null> {
    const file = Bun.file(this.path_for(content_hash));
    if (!(await file.exists())) return null;
    return file.text();
  }

  async exists(content_hash: string): Promise<boolean> {
    try {
      await access(this.path_for(content_hash));
      return true;
    } catch {
      return false;
    }
  }

  async delete(content_hash: string): Promise<void> {
    await rm(this.path_for(content_hash), { force: true });
  }
}
