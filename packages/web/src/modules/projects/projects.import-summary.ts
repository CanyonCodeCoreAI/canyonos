// What the import screen can honestly say about an upload before it is created, derived from the
// same rules the API admits against. Pure so it can be read in a test rather than through the DOM.

import {
  classify_component,
  isEnvFile,
  MAX_TOTAL_BYTES,
  TEXT_EXTENSIONS,
} from '@canyonos/api/projects';
import type { FileComponentKind } from '@canyonos/api/projects';

import type { ParsedFile, ParsedUpload } from '@/modules/projects/projects.upload';

/**
 * `classify_component` reads a filename and nothing else, so it can only ever answer workflow, agent
 * or other — never `tool`, even though the kind union carries one. Counting tools here would print a
 * permanent zero, so the summary reports the two kinds that can actually be found plus a file total.
 */
export interface ImportCounts {
  readonly workflows: number;
  readonly agents: number;
  readonly files: number;
}

export interface ImportFileRow {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: FileComponentKind;
}

export function countComponents(files: readonly ParsedFile[]): ImportCounts {
  let workflows = 0;
  let agents = 0;
  for (const file of files) {
    const kind = classify_component(file.path);
    if (kind === 'workflow') workflows += 1;
    else if (kind === 'agent') agents += 1;
  }
  return { workflows, agents, files: files.length };
}

/**
 * Flat, path-sorted rows with a depth for indentation. Flat rather than nested because the list is
 * read-only here: a tree would need collapse state that nothing in the import flow acts on, and the
 * sidebar already owns the collapsible view of a project's sources once it exists.
 */
export function toFileRows(files: readonly ParsedFile[]): ImportFileRow[] {
  return files
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      const segments = file.path.split('/');
      return {
        path: file.path,
        name: segments.at(-1) ?? file.path,
        depth: segments.length - 1,
        kind: classify_component(file.path),
      };
    });
}

/** Groups skip reasons so the summary states why files were left out, not just how many. */
export function describeSkipped(upload: ParsedUpload): string | null {
  if (upload.skipped.length === 0) return null;
  const reasons = new Map<string, number>();
  for (const skip of upload.skipped) {
    reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
  }
  const parts = [...reasons.entries()].map(([reason, count]) => `${count} ${reason}`);
  return `${upload.skipped.length} skipped (${parts.join(', ')})`;
}

export function findEnvFiles(files: readonly ParsedFile[]): string[] {
  return files.filter((file) => isEnvFile(file.path)).map((file) => file.path);
}

/** The real allow-list, so the footer never promises an extension the API would reject. */
export const READABLE_EXTENSIONS = [...TEXT_EXTENSIONS, '.env*'].join(' ');

/** Derived from the API's admission cap, so the footer never overstates it. */
export const TOTAL_SIZE_LIMIT_LABEL = `Up to ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB`;
