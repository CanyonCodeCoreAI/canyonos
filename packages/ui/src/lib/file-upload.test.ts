import { describe, expect, it } from 'bun:test';

import {
  fileUploadReducer,
  initialFileUploadState,
  matchesAccept,
  readFileText,
  validateFile,
} from './file-upload';
import type { FileError, UploadedFile } from './file-upload';

const file = (name: string, type = '', size = 0): File => {
  const blob = new File([new Uint8Array(size)], name, { type });
  return blob;
};

const SSH_ACCEPT = '.pem,.key,.crt,.cer,application/x-pem-file,text/plain';

describe('matchesAccept', () => {
  it('matches by extension even when the MIME type is empty (.pem)', () => {
    expect(matchesAccept(file('id_rsa.pem'), SSH_ACCEPT)).toBe(true);
    expect(matchesAccept(file('server.key'), SSH_ACCEPT)).toBe(true);
  });

  it('matches an exact MIME type', () => {
    expect(matchesAccept(file('notes.txt', 'text/plain'), SSH_ACCEPT)).toBe(true);
  });

  it('matches a MIME wildcard', () => {
    expect(matchesAccept(file('photo.png', 'image/png'), 'image/*')).toBe(true);
    expect(matchesAccept(file('photo.png', 'image/png'), 'video/*')).toBe(false);
  });

  it('rejects a file that matches no token', () => {
    expect(matchesAccept(file('malware.exe', 'application/x-msdownload'), SSH_ACCEPT)).toBe(false);
  });

  it('accepts anything when the accept list is empty', () => {
    expect(matchesAccept(file('anything.bin'), '')).toBe(true);
    expect(matchesAccept(file('anything.bin'), '  ,  ')).toBe(true);
  });
});

describe('validateFile', () => {
  it('flags a disallowed type', () => {
    const error = validateFile(file('malware.exe'), { accept: SSH_ACCEPT });
    expect(error?.code).toBe('file-invalid-type');
  });

  it('flags an oversize file', () => {
    const error = validateFile(file('big.pem', '', 2048), { accept: SSH_ACCEPT, maxSize: 1024 });
    expect(error?.code).toBe('file-too-large');
  });

  it('returns null for a valid file', () => {
    expect(validateFile(file('id.pem', '', 512), { accept: SSH_ACCEPT, maxSize: 1024 })).toBeNull();
  });

  it('returns null when no constraints are supplied', () => {
    expect(validateFile(file('anything.bin'), {})).toBeNull();
  });
});

describe('readFileText', () => {
  it('resolves the file text contents', async () => {
    const contents = '-----BEGIN PRIVATE KEY-----';
    expect(await readFileText(new File([contents], 'id.pem', { type: '' }))).toBe(contents);
  });
});

describe('fileUploadReducer', () => {
  const uploaded = (name: string): UploadedFile => ({ file: file(name) });

  it('replaces files on FILES_ADDED when not multiple', () => {
    const start = { ...initialFileUploadState, files: [uploaded('old.pem')] };
    const next = fileUploadReducer(start, {
      type: 'FILES_ADDED',
      files: [uploaded('new.pem')],
      multiple: false,
    });
    expect(next.files.map((entry) => entry.file.name)).toEqual(['new.pem']);
  });

  it('appends files and clears errors on FILES_ADDED when multiple', () => {
    const start = {
      files: [uploaded('a.pem')],
      errors: [
        { file: file('bad.exe'), code: 'file-invalid-type', message: 'x' } satisfies FileError,
      ],
      isDragging: true,
    };
    const next = fileUploadReducer(start, {
      type: 'FILES_ADDED',
      files: [uploaded('b.pem')],
      multiple: true,
    });
    expect(next.files.map((entry) => entry.file.name)).toEqual(['a.pem', 'b.pem']);
    expect(next.errors).toEqual([]);
    expect(next.isDragging).toBe(false);
  });

  it('sets errors and stops dragging on FILES_REJECTED', () => {
    const errors: FileError[] = [
      { file: file('bad.exe'), code: 'file-invalid-type', message: 'x' },
    ];
    const next = fileUploadReducer(
      { ...initialFileUploadState, isDragging: true },
      { type: 'FILES_REJECTED', errors }
    );
    expect(next.errors).toBe(errors);
    expect(next.isDragging).toBe(false);
  });

  it('toggles the dragging flag', () => {
    expect(fileUploadReducer(initialFileUploadState, { type: 'DRAG_ENTER' }).isDragging).toBe(true);
    expect(
      fileUploadReducer({ ...initialFileUploadState, isDragging: true }, { type: 'DRAG_LEAVE' })
        .isDragging
    ).toBe(false);
  });

  it('removes a file by identity on REMOVE', () => {
    const keep = uploaded('keep.pem');
    const drop = uploaded('drop.pem');
    const next = fileUploadReducer(
      { ...initialFileUploadState, files: [keep, drop] },
      { type: 'REMOVE', file: drop.file }
    );
    expect(next.files).toEqual([keep]);
  });

  it('returns the initial state on RESET', () => {
    const next = fileUploadReducer(
      { files: [uploaded('a.pem')], errors: [], isDragging: true },
      { type: 'RESET' }
    );
    expect(next).toEqual(initialFileUploadState);
  });
});
