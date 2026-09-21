import type { FileComponentKind, FileMeta } from '@canyonos/api/projects';

interface FileTreeNodeBase {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
}

export interface FileTreeFolder extends FileTreeNodeBase {
  readonly kind: 'folder';
  readonly tone: 'folder';
  readonly path: string;
  readonly children: readonly FileTreeRow[];
}

export interface FileTreeFile extends FileTreeNodeBase {
  readonly kind: 'file';
  readonly tone: FileComponentKind;
  readonly file_id: string;
  readonly component_kind: FileComponentKind;
}

export type FileTreeRow = FileTreeFolder | FileTreeFile;

interface TreeNode {
  name: string;
  file?: FileMeta;
  children: Map<string, TreeNode>;
}

/**
 * Turn the flat file list the API returns into the sidebar's nested rows: folders before files at
 * every depth, each alphabetical, with workflow sources hoisted to the top of the root so the entry
 * point of the project is the first thing in the tree.
 */
export function buildFileTree(files: readonly FileMeta[]): FileTreeRow[] {
  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map() };
        node.children.set(segment, child);
      }
      if (index === segments.length - 1) child.file = file;
      node = child;
    });
  }

  const walk = (node: TreeNode, depth: number, prefix: string): FileTreeRow[] => {
    const entries = [...node.children.values()];
    const folders = entries
      .filter((entry) => !entry.file)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const leaves = entries
      .filter((entry) => entry.file)
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const folder_rows: FileTreeFolder[] = folders.map((folder) => {
      const path = `${prefix}${folder.name}/`;
      return {
        id: `dir:${path}`,
        name: folder.name,
        kind: 'folder',
        tone: 'folder',
        depth,
        path: path.slice(0, -1),
        children: walk(folder, depth + 1, path),
      };
    });
    const file_rows: FileTreeFile[] = leaves.map((leaf) => {
      const file = leaf.file!;
      return {
        id: file.id,
        name: file.name,
        kind: 'file',
        tone: file.component_kind,
        depth,
        file_id: file.id,
        component_kind: file.component_kind,
      };
    });

    return [...folder_rows, ...file_rows];
  };

  return walk(root, 0, '').toSorted(
    (left, right) =>
      Number(right.kind === 'file' && right.component_kind === 'workflow') -
      Number(left.kind === 'file' && left.component_kind === 'workflow')
  );
}
