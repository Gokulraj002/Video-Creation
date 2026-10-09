import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { config, ROOT_DIR } from '@vc/core';

const ENTRY_POINT = path.join(ROOT_DIR, 'packages/video/src/index.ts');
const browserExecutable = config.CHROME_EXECUTABLE ?? null;

let serveUrl: Promise<string> | undefined;
let browser: ReturnType<typeof openBrowser> | undefined;

/** Bundles the Remotion project once per worker process. */
export function getServeUrl(): Promise<string> {
  serveUrl ??= bundle({ entryPoint: ENTRY_POINT });
  return serveUrl;
}

function getBrowser(): ReturnType<typeof openBrowser> {
  browser ??= openBrowser('chrome', { browserExecutable });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  const b = browser;
  browser = undefined;
  await (await b).close({ silent: true }).catch(() => undefined);
}

export async function renderComposition(
  compositionId: string,
  inputProps: Record<string, unknown>,
  outputLocation: string,
): Promise<void> {
  const url = await getServeUrl();
  const puppeteerInstance = await getBrowser();
  try {
    const composition = await selectComposition({
      serveUrl: url,
      id: compositionId,
      inputProps,
      puppeteerInstance,
      browserExecutable,
      logLevel: 'warn',
    });
    await renderMedia({
      composition,
      serveUrl: url,
      codec: 'h264',
      outputLocation,
      inputProps,
      puppeteerInstance,
      browserExecutable,
      enforceAudioTrack: true,
      logLevel: 'warn',
    });
  } catch (err) {
    // A crashed browser would fail every following job; start fresh next time
    await closeBrowser();
    throw err;
  }
}
