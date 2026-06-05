import { timingSafeEqual } from "node:crypto";

/**
 * Verify Gitee webhook token.
 * Gitee sends the webhook password directly in the X-Gitee-Token header.
 * Not HMAC — just a simple token comparison.
 */
export function verifyGiteeSignature(
  rawBody: string,
  token: string | undefined,
  secret: string,
): boolean {
  if (!token) return false;

  try {
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(secret);
    if (tokenBuf.length !== secretBuf.length) return false;
    return timingSafeEqual(tokenBuf, secretBuf);
  } catch {
    return false;
  }
}
