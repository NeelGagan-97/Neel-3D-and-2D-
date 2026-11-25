/**
 * Neutralizes spreadsheet formula injection in exported CSV cells while preserving
 * ordinary text and real numeric values untouched.
 *
 * Handles leading '=', '+', '-', '@', tab, and carriage return characters even when
 * preceded by leading spaces or control characters.
 */
const FORMULA_TRIGGER_PATTERN = /^[\s\x00-\x1f]*[=+\-@\t\r]/;

export function sanitizeCsvTextValue(raw: string): string {
  if (!raw) return '';
  if (FORMULA_TRIGGER_PATTERN.test(raw)) {
    return `'${raw}`;
  }
  return raw;
}

/**
 * Formats a single CSV cell safely according to RFC-4180 and formula-injection rules:
 * - Finite numbers remain unquoted numeric literals (preserving negative numbers & precision).
 * - Strings are neutralized against spreadsheet formula evaluation and safely RFC-4180 quoted.
 * - Null/undefined values become empty cells.
 */
export function formatSafeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '""';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  const safe = sanitizeCsvTextValue(String(value));
  return `"${safe.replace(/"/g, '""')}"`;
}

export function formatSafeCsvRow(
  cells: ReadonlyArray<string | number | boolean | null | undefined>
): string {
  return cells.map((cell) => formatSafeCsvCell(cell)).join(',');
}
