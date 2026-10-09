import { describe, expect, it } from 'vitest';
import nextConfig, { contentSecurityPolicy, securityHeaders } from '../../next.config';

describe('security headers', () => {
  it('has no unsafe-eval in production, only in development', () => {
    expect(contentSecurityPolicy(false)).not.toContain('unsafe-eval');
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy(false)).not.toContain('ws:');
  });

  it('forbids framing and plugins', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    const byKey = new Map(securityHeaders(false).map((h) => [h.key, h.value]));
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(byKey.get('Permissions-Policy')).toContain('camera=()');
  });

  it('applies to every route', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('/:path*');
  });
});
