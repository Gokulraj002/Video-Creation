import type { NextConfig } from 'next';

/**
 * Content-Security-Policy for the Next.js App Router + the Remotion `<Player>` animatic (static, set via `headers()`).
 *
 * What had to be allowed, and why:
 * - `script-src 'unsafe-inline'`: the App Router streams the RSC payload as inline `<script>` tags and the root layout
 *   has a tiny inline theme script (no flash of the wrong theme). Without per-request nonces (which would need a
 *   `proxy.ts` that rewrites every response) inline scripts cannot be allow-listed any other way — hashes would make
 *   browsers ignore `'unsafe-inline'` and block the RSC payload.
 * - No `'unsafe-eval'` in production: React, Next.js and Remotion do not eval in production builds, and Zod runs
 *   `jitless` in the browser (`src/lib/zod-jitless.ts`). Development adds `'unsafe-eval'` (React dev tooling) and
 *   `ws:` / `wss:` (HMR).
 * - `style-src 'unsafe-inline'`: React `style` attributes (the Remotion composition is all inline styles) and the
 *   Player injects a `<style>` element at runtime.
 * - `media-src data: blob:`: the Remotion Player plays a tiny silent `data:audio/mp3` clip to unlock audio playback.
 * - `img-src data: blob:` / `font-src data:`: inline icons and data-URI assets.
 * Everything else is same-origin only; the page cannot be framed (`frame-ancestors 'none'` + `X-Frame-Options`).
 */
export function contentSecurityPolicy(dev: boolean): string {
  const directives: Record<string, readonly string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...(dev ? ['ws:', 'wss:'] : [])],
    'media-src': ["'self'", 'data:', 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(dev) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      // Fullscreen stays available to this origin (the animatic player's fullscreen button).
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), fullscreen=(self)',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
}

const nextConfig: NextConfig = {
  // `@vc/schema` is consumed as TypeScript source (no build step).
  transpilePackages: ['@vc/schema'],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'development') }];
  },
};

export default nextConfig;
