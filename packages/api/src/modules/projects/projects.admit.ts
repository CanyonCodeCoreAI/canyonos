import { badRequest } from '@core/errors';

import {
  baseName,
  classify_component,
  containsNullChar,
  isSafeRelPath,
  isSupportedFile,
  languageForPath,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from './projects.files';
import type { AdmittedFile, FileUpload } from './projects.files';

/**
 * Validate and normalize an uploaded file set into persist-ready values. Throws `badRequest` on the
 * first violation — the only place upload admission lives. Server-only, so the shareable rules stay
 * in projects.files.ts.
 */
export function admitFiles(inputs: readonly FileUpload[]): AdmittedFile[] {
  const seen = new Set<string>();
  let total = 0;

  const admitted = inputs.map((file) => {
    if (!isSafeRelPath(file.path)) {
      throw badRequest('projects.invalid_path', `Unsafe file path: ${file.path}`);
    }
    if (!isSupportedFile(file.path)) {
      throw badRequest('projects.unsupported_file', `Unsupported file type: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw badRequest('projects.duplicate_path', `Duplicate file path: ${file.path}`);
    }
    seen.add(file.path);

    if (containsNullChar(file.content)) {
      throw badRequest(
        'projects.invalid_content',
        `File content contains a NUL byte: ${file.path}`
      );
    }

    const byte_size = Buffer.byteLength(file.content, 'utf8');
    if (byte_size > MAX_FILE_BYTES) {
      throw badRequest('projects.file_too_large', `File exceeds size limit: ${file.path}`);
    }
    total += byte_size;

    return {
      path: file.path,
      name: baseName(file.path),
      content: file.content,
      language: languageForPath(file.path),
      byte_size,
      component_kind: classify_component(file.path),
    };
  });

  if (total > MAX_TOTAL_BYTES) {
    throw badRequest('projects.upload_too_large', 'Upload exceeds the total size limit');
  }
  return admitted;
}
