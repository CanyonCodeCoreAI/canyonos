import { config } from '@core/env';

import { create_mock_blob_store } from './file-storage.provider.mock';
import type { BlobStore } from './file-storage.provider';

/** The process-wide blob store, a local folder rooted at `FILE_STORAGE_MOCK_DIR`. */
export const blob_store: BlobStore = create_mock_blob_store(config.storage.mockDir);

export type { BlobStore } from './file-storage.provider';
export { hash_content } from './file-storage.provider';
