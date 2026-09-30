export type FileErrorCode = 'file-invalid-type' | 'file-too-large' | 'file-read-error';

export interface FileError {
  file: File;
  code: FileErrorCode;
  message: string;
}

export interface UploadedFile {
  file: File;
  text?: string;
}

export interface ValidateFileOptions {
  accept?: string;
  maxSize?: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/**
 * The `accept` attribute is only an advisory hint to the file picker, so every dropped, pasted, or
 * picked file is re-checked here. A token matches by extension (`.pem`), by exact MIME
 * (`text/plain`), or by MIME wildcard (`text/*`). Extension matching is what saves `.pem`/`.key`
 * files, which the browser reports with an empty `file.type`.
 */
export const matchesAccept = (file: File, accept: string): boolean => {
  const tokens = accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const name = file.name.toLowerCase();
  const type = (file.type.toLowerCase().split(';')[0] ?? '').trim();

  return tokens.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
};

export const validateFile = (file: File, opts: ValidateFileOptions): FileError | null => {
  if (opts.accept && !matchesAccept(file, opts.accept)) {
    return {
      file,
      code: 'file-invalid-type',
      message: `${file.name} is not an accepted file type.`,
    };
  }
  if (opts.maxSize != null && file.size > opts.maxSize) {
    return {
      file,
      code: 'file-too-large',
      message: `${file.name} is larger than the ${formatBytes(opts.maxSize)} limit.`,
    };
  }
  return null;
};

export const readFileText = (file: File): Promise<string> => {
  if (typeof file.text === 'function') return file.text();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
};

export interface FileUploadState {
  files: UploadedFile[];
  errors: FileError[];
  isDragging: boolean;
}

export type FileUploadAction =
  | { type: 'FILES_ADDED'; files: UploadedFile[]; multiple: boolean }
  | { type: 'FILES_REJECTED'; errors: FileError[] }
  | { type: 'DRAG_ENTER' }
  | { type: 'DRAG_LEAVE' }
  | { type: 'REMOVE'; file: File }
  | { type: 'RESET' };

export const initialFileUploadState: FileUploadState = {
  files: [],
  errors: [],
  isDragging: false,
};

export const fileUploadReducer = (
  state: FileUploadState,
  action: FileUploadAction
): FileUploadState => {
  switch (action.type) {
    case 'FILES_ADDED':
      return {
        files: action.multiple ? [...state.files, ...action.files] : action.files,
        errors: [],
        isDragging: false,
      };
    case 'FILES_REJECTED':
      return { ...state, errors: action.errors, isDragging: false };
    case 'DRAG_ENTER':
      return { ...state, isDragging: true };
    case 'DRAG_LEAVE':
      return { ...state, isDragging: false };
    case 'REMOVE':
      return { ...state, files: state.files.filter((entry) => entry.file !== action.file) };
    case 'RESET':
      return initialFileUploadState;
    default:
      return state;
  }
};
