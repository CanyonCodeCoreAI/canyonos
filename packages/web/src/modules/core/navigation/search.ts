export function parseFileSearch(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
