export interface SafeUrlValidationResult {
  valid: boolean;
  normalized?: string;
  error?: string;
}

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * Validates and normalizes an external product/reference URL.
 * Accepts valid https:// and http:// URLs (matching existing Blue Space catalogue policy),
 * and strictly rejects javascript:, vbscript:, data:, file:, blob:, protocol-relative,
 * control-character, or malformed URLs.
 */
export function validateSafeUrl(
  raw: unknown,
  fieldLabel = 'URL'
): SafeUrlValidationResult {
  if (raw === null || raw === undefined) {
    return { valid: true, normalized: undefined };
  }
  if (typeof raw !== 'string') {
    return { valid: false, error: `${fieldLabel} must be a valid https:// or http:// URL.` };
  }

  // Strip surrounding whitespace; reject embedded ASCII control characters
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, normalized: undefined };
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { valid: false, error: `${fieldLabel} contains invalid control characters.` };
  }

  // Reject protocol-relative URLs (e.g. //evil.example)
  if (trimmed.startsWith('//')) {
    return { valid: false, error: `${fieldLabel} must include an explicit https:// or http:// scheme.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: `${fieldLabel} is not a valid URL. Use a full https:// or http:// address.`,
    };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return {
      valid: false,
      error: `${fieldLabel} uses an unsupported protocol ("${protocol}"). Only https:// and http:// links are permitted.`,
    };
  }

  if (!parsed.hostname || parsed.hostname.length < 1) {
    return { valid: false, error: `${fieldLabel} must include a valid host name.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: `${fieldLabel} must not contain embedded credentials.` };
  }

  return { valid: true, normalized: parsed.toString() };
}

/**
 * Returns a normalized safe https:// or http:// URL, or undefined if blank or unsafe.
 * Suitable for import sanitization and defense-in-depth rendering checks.
 */
export function sanitizeSafeUrl(raw: unknown): string | undefined {
  const res = validateSafeUrl(raw);
  return res.valid ? res.normalized : undefined;
}
