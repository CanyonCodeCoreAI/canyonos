import { diffLines } from 'diff';

import { internalError } from '@core/errors';

import { projects_repo } from '../projects/projects.repo';
import { blob_store } from '../storage/file-storage';
import { deployments_repo } from './deploy.repo';
import type { ProjectDeployFile } from '../projects/projects.repo';
import type { DeployPreview, DeployPreviewFile, DiffRow } from './deploy.types';

// diffLines keeps the trailing newline on each part's value, so a split leaves an empty final element.
// Dropping it makes an N-line file yield N rows instead of N+1.
function split_lines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

function whole_file_rows(text: string, side: 'added' | 'removed'): DiffRow[] {
  return split_lines(text).map((line, index) => {
    const number = index + 1;
    return side === 'added'
      ? { kind: 'added', old_line: null, new_line: number, old_text: null, new_text: line }
      : { kind: 'removed', old_line: number, new_line: null, old_text: line, new_text: null };
  });
}

// Walk the jsdiff parts into aligned side-by-side rows. A removed part immediately followed by an
// added part is zipped line-by-line into `changed` rows; any surplus on either side becomes its own
// removed/added rows. A part with no partner stays a plain removed or added block.
export function align_diff_rows(base_text: string, current_text: string): DiffRow[] {
  const parts = diffLines(base_text, current_text);
  const rows: DiffRow[] = [];
  let old_line = 1;
  let new_line = 1;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;

    if (!part.added && !part.removed) {
      for (const line of split_lines(part.value)) {
        rows.push({
          kind: 'unchanged',
          old_line,
          new_line,
          old_text: line,
          new_text: line,
        });
        old_line += 1;
        new_line += 1;
      }
      continue;
    }

    if (part.removed) {
      const removed_lines = split_lines(part.value);
      const next = parts[index + 1];
      const added_lines = next?.added ? split_lines(next.value) : [];
      if (next?.added) index += 1;

      const paired = Math.min(removed_lines.length, added_lines.length);
      for (let row = 0; row < paired; row += 1) {
        rows.push({
          kind: 'changed',
          old_line,
          new_line,
          old_text: removed_lines[row]!,
          new_text: added_lines[row]!,
        });
        old_line += 1;
        new_line += 1;
      }
      for (let row = paired; row < removed_lines.length; row += 1) {
        rows.push({
          kind: 'removed',
          old_line,
          new_line: null,
          old_text: removed_lines[row]!,
          new_text: null,
        });
        old_line += 1;
      }
      for (let row = paired; row < added_lines.length; row += 1) {
        rows.push({
          kind: 'added',
          old_line: null,
          new_line,
          old_text: null,
          new_text: added_lines[row]!,
        });
        new_line += 1;
      }
      continue;
    }

    for (const line of split_lines(part.value)) {
      rows.push({ kind: 'added', old_line: null, new_line, old_text: null, new_text: line });
      new_line += 1;
    }
  }

  return rows;
}

async function load_blob(content_hash: string): Promise<string> {
  const text = await blob_store.get(content_hash);
  if (text === null) {
    throw internalError(
      'deploy.preview_blob_missing',
      `File content for hash "${content_hash}" is missing from storage`
    );
  }
  return text;
}

export async function get_deploy_preview(project_id: string): Promise<DeployPreview> {
  const current = await projects_repo.get_deploy_files(project_id);
  const base_deployment = await deployments_repo.find_latest_success_by_project(project_id);
  const base_manifest = base_deployment
    ? await deployments_repo.list_manifest(base_deployment.id)
    : [];

  const current_by_path = new Map(current.map((file) => [file.path, file]));
  const base_by_path = new Map(base_manifest.map((file) => [file.path, file]));
  const paths = [...new Set([...current_by_path.keys(), ...base_by_path.keys()])].sort();

  const files: DeployPreviewFile[] = [];
  const summary = { added: 0, removed: 0, modified: 0 };

  for (const path of paths) {
    const current_file = current_by_path.get(path);
    const base_file = base_by_path.get(path);

    if (current_file && !base_file) {
      files.push(await added_file(current_file));
      summary.added += 1;
      continue;
    }
    if (!current_file && base_file) {
      files.push(await removed_file(base_file));
      summary.removed += 1;
      continue;
    }
    if (current_file && base_file && current_file.content_hash !== base_file.content_hash) {
      files.push(await modified_file(base_file, current_file));
      summary.modified += 1;
    }
  }

  return {
    base_deployment_id: base_deployment?.id ?? null,
    base_created_at: base_deployment?.created_at ?? null,
    has_changes: files.length > 0,
    summary,
    files,
  };
}

async function added_file(file: ProjectDeployFile): Promise<DeployPreviewFile> {
  const text = await load_blob(file.content_hash);
  return {
    path: file.path,
    component_kind: file.component_kind,
    change: 'added',
    rows: whole_file_rows(text, 'added'),
  };
}

async function removed_file(file: ProjectDeployFile): Promise<DeployPreviewFile> {
  const text = await load_blob(file.content_hash);
  return {
    path: file.path,
    component_kind: file.component_kind,
    change: 'removed',
    rows: whole_file_rows(text, 'removed'),
  };
}

async function modified_file(
  base_file: ProjectDeployFile,
  current_file: ProjectDeployFile
): Promise<DeployPreviewFile> {
  const [base_text, current_text] = await Promise.all([
    load_blob(base_file.content_hash),
    load_blob(current_file.content_hash),
  ]);
  return {
    path: current_file.path,
    component_kind: current_file.component_kind,
    change: 'modified',
    rows: align_diff_rows(base_text, current_text),
  };
}
