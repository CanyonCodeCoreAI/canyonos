interface JwtPayload {
  exp?: number;
}

const decodeBase64Url = (segment: string): string => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return atob(padded);
};

const decodeTokenPayload = (token: string): JwtPayload | null => {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) return null;
  try {
    return JSON.parse(decodeBase64Url(payloadSegment)) as JwtPayload;
  } catch {
    return null;
  }
};

/**
 * Client-side expiry check from the JWT `exp` claim. The signature is NOT verified here
 * (the secret is server-only) — this only short-circuits clearly-expired tokens before
 * navigation. A token with no readable `exp` is deferred to the server's profile check.
 */
export const isTokenExpired = (token: string): boolean => {
  const payload = decodeTokenPayload(token);
  if (!payload?.exp) return false;
  return payload.exp * 1000 <= Date.now();
};
