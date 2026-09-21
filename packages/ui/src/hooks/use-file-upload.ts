import * as React from 'react';

import {
  fileUploadReducer,
  initialFileUploadState,
  readFileText,
  validateFile,
} from '../lib/file-upload';
import type { FileError, UploadedFile } from '../lib/file-upload';

export type { FileError, UploadedFile } from '../lib/file-upload';

export interface UseFileUploadOptions {
  accept?: string;
  maxSize?: number;
  multiple?: boolean;
  readAs?: 'text' | 'none';
  disabled?: boolean;
  onFiles?: (files: UploadedFile[]) => void;
  onError?: (errors: FileError[]) => void;
}

export interface FileUploadRootProps {
  role: 'button';
  tabIndex: number;
  'aria-disabled'?: true;
  onClick: () => void;
  onKeyDown: React.KeyboardEventHandler;
  onDragEnter: React.DragEventHandler;
  onDragOver: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  onPaste: React.ClipboardEventHandler;
}

export interface FileUploadInputProps {
  ref: React.RefObject<HTMLInputElement | null>;
  type: 'file';
  disabled: boolean;
  accept?: string;
  multiple: boolean;
  tabIndex: -1;
  'aria-hidden': true;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}

export interface UseFileUploadReturn {
  files: UploadedFile[];
  errors: FileError[];
  isDragging: boolean;
  open: () => void;
  reset: () => void;
  remove: (file: File) => void;
  getRootProps: () => FileUploadRootProps;
  getInputProps: () => FileUploadInputProps;
}

export function useFileUpload(options: UseFileUploadOptions = {}): UseFileUploadReturn {
  const { accept, maxSize, multiple = false, readAs = 'none', disabled = false } = options;

  const [state, dispatch] = React.useReducer(fileUploadReducer, initialFileUploadState);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const dragCounter = React.useRef(0);
  const readToken = React.useRef(0);

  const onFilesRef = React.useRef(options.onFiles);
  onFilesRef.current = options.onFiles;
  const onErrorRef = React.useRef(options.onError);
  onErrorRef.current = options.onError;

  const processFiles = React.useCallback(
    async (list: FileList | File[]) => {
      if (disabled) return;
      const selected = multiple ? Array.from(list) : Array.from(list).slice(0, 1);
      if (selected.length === 0) return;

      // Every real selection supersedes any in-flight async read, so a later rejection is never
      // overwritten by an earlier read that resolves late.
      const token = (readToken.current += 1);

      const accepted: File[] = [];
      const rejected: FileError[] = [];
      for (const file of selected) {
        const error = validateFile(file, { accept, maxSize });
        if (error) rejected.push(error);
        else accepted.push(file);
      }

      let uploaded: UploadedFile[] = [];
      if (accepted.length > 0 && readAs === 'text') {
        const results = await Promise.all(
          accepted.map(async (file): Promise<UploadedFile | FileError> => {
            try {
              return { file, text: await readFileText(file) };
            } catch {
              return { file, code: 'file-read-error', message: `Could not read ${file.name}.` };
            }
          })
        );
        if (token !== readToken.current) return;
        for (const result of results) {
          if ('code' in result) rejected.push(result);
          else uploaded.push(result);
        }
      } else if (accepted.length > 0) {
        uploaded = accepted.map((file) => ({ file }));
      }

      if (uploaded.length > 0) {
        dispatch({ type: 'FILES_ADDED', files: uploaded, multiple });
        onFilesRef.current?.(uploaded);
      }
      if (rejected.length > 0) {
        dispatch({ type: 'FILES_REJECTED', errors: rejected });
        onErrorRef.current?.(rejected);
      }
    },
    [accept, disabled, maxSize, multiple, readAs]
  );

  const open = React.useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const reset = React.useCallback(() => {
    readToken.current += 1;
    dragCounter.current = 0;
    dispatch({ type: 'RESET' });
  }, []);

  const remove = React.useCallback((file: File) => {
    dispatch({ type: 'REMOVE', file });
  }, []);

  const handleKeyDown = React.useCallback<React.KeyboardEventHandler>(
    (event) => {
      if (disabled) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    },
    [disabled, open]
  );

  const handleDragEnter = React.useCallback<React.DragEventHandler>(
    (event) => {
      event.preventDefault();
      if (disabled) return;
      dragCounter.current += 1;
      if (dragCounter.current === 1) dispatch({ type: 'DRAG_ENTER' });
    },
    [disabled]
  );

  const handleDragOver = React.useCallback<React.DragEventHandler>(
    (event) => {
      if (disabled) return;
      event.preventDefault();
    },
    [disabled]
  );

  const handleDragLeave = React.useCallback<React.DragEventHandler>(
    (event) => {
      event.preventDefault();
      if (disabled) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) dispatch({ type: 'DRAG_LEAVE' });
    },
    [disabled]
  );

  const handleDrop = React.useCallback<React.DragEventHandler>(
    (event) => {
      event.preventDefault();
      dragCounter.current = 0;
      if (disabled) return;
      dispatch({ type: 'DRAG_LEAVE' });
      void processFiles(event.dataTransfer.files);
    },
    [disabled, processFiles]
  );

  const handlePaste = React.useCallback<React.ClipboardEventHandler>(
    (event) => {
      if (disabled) return;
      const { clipboardData } = event;
      if (clipboardData.files.length > 0) {
        event.preventDefault();
        void processFiles(clipboardData.files);
        return;
      }
      if (readAs === 'text') {
        const text = clipboardData.getData('text/plain');
        if (text) {
          event.preventDefault();
          void processFiles([new File([text], 'pasted.txt', { type: 'text/plain' })]);
        }
      }
    },
    [disabled, readAs, processFiles]
  );

  const handleInputChange = React.useCallback<React.ChangeEventHandler<HTMLInputElement>>(
    (event) => {
      const { files } = event.target;
      if (files) void processFiles(files);
      event.target.value = '';
    },
    [processFiles]
  );

  const getRootProps = React.useCallback<() => FileUploadRootProps>(
    () => ({
      role: 'button',
      tabIndex: disabled ? -1 : 0,
      'aria-disabled': disabled || undefined,
      onClick: open,
      onKeyDown: handleKeyDown,
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onPaste: handlePaste,
    }),
    [
      disabled,
      open,
      handleKeyDown,
      handleDragEnter,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handlePaste,
    ]
  );

  const getInputProps = React.useCallback<() => FileUploadInputProps>(
    () => ({
      ref: inputRef,
      type: 'file',
      disabled,
      accept,
      multiple,
      tabIndex: -1,
      'aria-hidden': true,
      onChange: handleInputChange,
    }),
    [accept, disabled, multiple, handleInputChange]
  );

  return {
    files: state.files,
    errors: state.errors,
    isDragging: state.isDragging,
    open,
    reset,
    remove,
    getRootProps,
    getInputProps,
  };
}
