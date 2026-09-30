import { python } from '@codemirror/lang-python';
import { tags as t } from '@lezer/highlight';
import { createTheme } from '@uiw/codemirror-themes';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';

import { cn } from '../../lib/utils';

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly language?: 'python' | 'text';
  readonly readOnly?: boolean;
  readonly className?: string;
  /**
   * Accessible name for the editable region. CodeMirror's editing surface is a `role="textbox"`
   * with no inherent label, so screen readers announce nothing without this.
   */
  readonly ariaLabel?: string;
}

const cssVar = (name: string) => `var(${name})`;

/**
 * One theme, entirely CSS-var-driven. Because the colors resolve to `--editor-*` custom properties
 * at paint time, switching the app between light/dark (via the `.dark` scope) re-themes the editor
 * for free — no second CodeMirror theme to maintain.
 */
const editorTheme = createTheme({
  theme: 'light',
  settings: {
    background: cssVar('--editor-bg'),
    foreground: cssVar('--editor-fg'),
    caret: cssVar('--editor-cursor'),
    selection: cssVar('--editor-selection'),
    selectionMatch: cssVar('--editor-selection'),
    gutterBackground: cssVar('--editor-bg'),
    gutterForeground: cssVar('--editor-gutter'),
    gutterBorder: 'transparent',
    lineHighlight: cssVar('--editor-active-line'),
  },
  styles: [
    { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword], color: cssVar('--editor-keyword') },
    { tag: [t.string, t.special(t.string)], color: cssVar('--editor-string') },
    { tag: [t.comment, t.lineComment, t.blockComment], color: cssVar('--editor-comment'), fontStyle: 'italic' }, // prettier-ignore
    { tag: [t.number, t.bool, t.null], color: cssVar('--editor-number') },
    { tag: [t.function(t.variableName), t.definition(t.variableName)], color: cssVar('--editor-function') }, // prettier-ignore
  ],
});

const LANGUAGE_EXTENSIONS: Record<'python' | 'text', Extension[]> = {
  python: [python()],
  text: [],
};

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  className,
  ariaLabel,
}: CodeEditorProps) {
  const extensions = ariaLabel
    ? [
        ...LANGUAGE_EXTENSIONS[language],
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      ]
    : LANGUAGE_EXTENSIONS[language];

  return (
    <CodeMirror
      value={value}
      theme={editorTheme}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={onChange}
      height="100%"
      // Fill the host panel so CodeMirror's `.cm-scroller` (not the surrounding panel) owns
      // source scrolling. Without a bounded root height, `height="100%"` resolves against an
      // auto-height wrapper and the editor grows to its full content, getting clipped instead.
      className={cn('h-full', className)}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        autocompletion: false,
      }}
    />
  );
}
