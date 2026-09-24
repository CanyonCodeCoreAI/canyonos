import { LOG_DOMAINS, logger } from '@core/logger';

import { FilesystemBlobStore } from './file-storage.provider';

const storage_logger = logger.child({ domain: LOG_DOMAINS.DB });

/** The dev/E2E blob store: a `FilesystemBlobStore` rooted at a local folder, not the mounted volume. */
export function create_mock_blob_store(root: string): FilesystemBlobStore {
  storage_logger.info('using mock file storage', { root });
  return new FilesystemBlobStore(root);
}
