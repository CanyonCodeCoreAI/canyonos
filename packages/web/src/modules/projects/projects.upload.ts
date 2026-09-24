import { unzipSync } from 'fflate';

import {
  isSafeRelPath,
  isSupportedFile,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  TEXT_EXTENSIONS,
} from '@canyonos/api/projects';

export interface ParsedFile {
  readonly path: string;
  readonly content: string;
}
export type SkipReason = 'unsupported' | 'binary' | 'duplicate';
export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
}
export interface ParsedUpload {
  readonly name: string;
  readonly files: ParsedFile[];
  /** Files present in the source but left out (non-source, non-text, or duplicate) — surfaced to the user. */
  readonly skipped: SkippedFile[];
}
interface RawEntry {
  readonly path: string;
  /** Byte size known from metadata (folder picker) or the ZIP header — available without reading content. */
  readonly size: number;
  /** Deferred content read, invoked only after the entry clears path filters and size/count guards. */
  readonly read: () => Uint8Array | Promise<Uint8Array>;
}

/** Directories a tool or OS generates. Present in real projects, never project sources. */
const IGNORED_DIRECTORIES = /^(node_modules|\.venv|__pycache__|\.git|\.idea|\.vscode|__MACOSX)$/;

const isInIgnoredDirectory = (path: string) =>
  path.split('/').some((segment) => IGNORED_DIRECTORIES.test(segment));

/**
 * Must be called *before* reading/decompressing a file, so a large folder or ZIP bomb is
 * short-circuited on metadata rather than after its content is materialized.
 */
function createLimitGuard() {
  let count = 0;
  let total = 0;
  return (path: string, size: number) => {
    count += 1;
    if (count > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES}).`);
    if (size > MAX_FILE_BYTES) {
      throw new Error(`"${path}" exceeds the ${Math.round(MAX_FILE_BYTES / 1024)} KB per-file limit`); // prettier-ignore
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        `Upload exceeds the ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB limit.`
      );
    }
  };
}

/**
 * Build a JSON-safe upload from raw entries: drop generated directories, then strip a single shared
 * top-level folder (a `.zip`'s or folder-picker's wrapper) so the tree isn't redundantly nested,
 * then validate + decode. Throws friendly errors. The stripped wrapper name becomes the project name.
 */
async function buildUpload(
  fallbackName: string,
  entries: readonly RawEntry[]
): Promise<ParsedUpload> {
  const skipped: SkippedFile[] = [];

  // A generated directory is expected noise, so it's dropped silently. A file that fails only the
  // supported-file rule is one the user chose, so it's reported as skipped.
  const kept = entries.filter(({ path }) => {
    if (!path || isInIgnoredDirectory(path)) return false;
    if (isSupportedFile(path)) return true;
    skipped.push({ path, reason: 'unsupported' });
    return false;
  });

  // A wrapper folder exists only if every kept file shares one top-level segment.
  const tops = new Set(kept.map((e) => e.path.split('/')[0]));
  const wrapper = tops.size === 1 && kept.every((e) => e.path.includes('/')) ? [...tops][0]! : null;
  const rel = (path: string) => (wrapper ? path.split('/').slice(1).join('/') : path);
  const name = wrapper ?? fallbackName;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: ParsedFile[] = [];
  const seen = new Set<string>();
  const guard = createLimitGuard();

  for (const entry of kept) {
    const relPath = rel(entry.path);
    if (!relPath || !isSafeRelPath(relPath)) {
      skipped.push({ path: relPath || entry.path, reason: 'unsupported' });
      continue;
    }
    if (seen.has(relPath)) {
      skipped.push({ path: relPath, reason: 'duplicate' });
      continue;
    }
    guard(relPath, entry.size);
    let content: string;
    try {
      content = decoder.decode(await entry.read());
    } catch {
      skipped.push({ path: relPath, reason: 'binary' }); // not valid UTF-8 text
      continue;
    }
    seen.add(relPath);
    files.push({ path: relPath, content });
  }

  if (files.length === 0) {
    throw new Error(`No supported source files found (${TEXT_EXTENSIONS.join(', ')}).`);
  }
  return { name: name || 'workflow', files, skipped };
}

export async function parseFolder(list: FileList): Promise<ParsedUpload> {
  const arr = Array.from(list);
  if (arr.length === 0) throw new Error('No files selected.');
  const entries = arr.map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  }));
  return buildUpload('workflow', entries);
}

/**
 * Parse one picked file — a workflow entry point rather than a whole project. The project takes the
 * file's own name, because there is no wrapper folder to borrow one from.
 */
export async function parseSingleFile(file: File): Promise<ParsedUpload> {
  return buildUpload(file.name.replace(/\.[^.]+$/, '') || 'workflow', [
    {
      path: file.name,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    },
  ]);
}

export async function parseZip(file: File): Promise<ParsedUpload> {
  // Compressed bytes never exceed the uncompressed total, so an archive already over the budget
  // can't fit — reject it here rather than buffer it into memory via arrayBuffer() below.
  if (file.size > MAX_TOTAL_BYTES) {
    throw new Error(`Upload exceeds the ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB limit.`);
  }

  const skipped: SkippedFile[] = [];
  const guard = createLimitGuard();
  // fflate runs `filter` on each ZIP-header entry *before* inflating it, so a rejected entry is
  // never decompressed — a caps-busting bomb is stopped before it expands in memory.
  const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: ({ name, originalSize }) => {
      if (!name || name.endsWith('/') || isInIgnoredDirectory(name)) return false;
      if (!isSupportedFile(name)) {
        skipped.push({ path: name, reason: 'unsupported' });
        return false;
      }
      guard(name, originalSize);
      return true;
    },
  });
  const entries: RawEntry[] = Object.entries(unzipped).map(([path, bytes]) => ({
    path,
    size: bytes.byteLength,
    read: () => bytes,
  }));
  const parsed = await buildUpload(file.name.replace(/\.zip$/i, ''), entries);
  return { ...parsed, skipped: [...skipped, ...parsed.skipped] };
}

// ── Drag-and-drop support ──────────────────────────────────────────────────

function readAllDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          pump(); // readEntries returns in chunks; keep going until empty
        }
      }, reject);
    pump();
  });
}

async function collectEntry(entry: FileSystemEntry, prefix: string): Promise<RawEntry[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
    return [
      {
        path: `${prefix}${entry.name}`,
        size: file.size,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      },
    ];
  }
  const dirEntry = entry as FileSystemDirectoryEntry;
  const children = await readAllDirEntries(dirEntry.createReader());
  // Children are independent — walk them concurrently rather than one await at a time.
  const nested = await Promise.all(children.map((c) => collectEntry(c, `${prefix}${entry.name}/`)));
  return nested.flat();
}

/** Parse a drag-and-drop: a single .zip, or one/more dropped folders (recursed) / files. */
export async function parseDataTransfer(dt: DataTransfer): Promise<ParsedUpload> {
  const files = Array.from(dt.files);
  if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.zip')) {
    return parseZip(files[0]!);
  }

  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }

  if (roots.length > 0) {
    const nested = await Promise.all(roots.map((root) => collectEntry(root, '')));
    return buildUpload('workflow', nested.flat());
  }

  if (files.length > 0) return parseFolder(dt.files);
  throw new Error('Nothing to import — drop a folder or a .zip.');
}
