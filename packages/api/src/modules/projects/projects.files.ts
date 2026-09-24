// Upload file rules: path safety, the supported-file rule, size caps, and component classification.
// Pure and dependency-free so the browser can pre-validate against the same constants it ships to the
// API. Admission (which throws) lives in projects.admit.ts.

/** Max relative path length (chars). */
export const MAX_PATH_LENGTH = 1024;

/** Per-file source cap (bytes). Sources are small; large files are rejected up front. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Total upload cap (bytes) across all files in one project. */
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** Max files in a single uploaded project. */
export const MAX_FILES = 500;

export const TEXT_EXTENSIONS = [
  '.py',
  '.txt',
  '.md',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.yaml',
  '.yml',
] as const;

/** The one source for the kind union — projects.types builds its Zod enum from this array. */
export const FILE_COMPONENT_KINDS = ['workflow', 'agent', 'tool', 'other'] as const;

export type FileComponentKind = (typeof FILE_COMPONENT_KINDS)[number];

/** A raw uploaded file before admission. */
export interface FileUpload {
  readonly path: string;
  readonly content: string;
}

/** A validated, persist-ready file. Snake_case to match the DB columns and the API contract. */
export interface AdmittedFile {
  readonly path: string;
  readonly name: string;
  readonly content: string;
  readonly language: string;
  readonly byte_size: number;
  readonly component_kind: FileComponentKind;
}

export function languageForPath(path: string): 'python' | 'text' {
  return path.toLowerCase().endsWith('.py') ? 'python' : 'text';
}

/**
 * A NUL byte cannot be stored in a PostgreSQL `text` column, so file content carrying one must be
 * rejected at admission rather than surfacing as a 500 from the driver. Shareable so the browser can
 * pre-validate against the same rule.
 */
export function containsNullChar(value: string): boolean {
  return value.includes('\u0000');
}

/**
 * A relative POSIX path is safe when it has no absolute prefix, no backslashes, only a conservative
 * character set, and every segment is a real name (no `.`/`..`/empty). This blocks path traversal
 * before anything reaches the database.
 */
export function isSafeRelPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function hasAllowedExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** `.env`, `.env.local` and `.env.production` share a prefix, not an extension. */
export function isEnvFile(path: string): boolean {
  return baseName(path).toLowerCase().startsWith('.env');
}

export function isSupportedFile(path: string): boolean {
  return hasAllowedExtension(path) || isEnvFile(path);
}

/** Extract the final path segment as the display and persistence filename. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Demo-stage classification: a filename is all we have, and a real `portfolio.py` gives no honest
 * signal, so every Python source that isn't a workflow is admitted as an agent. Deliberately coarse
 * until the runtime can report what a file actually is.
 */
export function classify_component(path: string): FileComponentKind {
  const name = baseName(path).toLowerCase();
  if (!name.endsWith('.py')) return 'other';
  if (name.includes('workflow')) return 'workflow';
  return 'agent';
}
