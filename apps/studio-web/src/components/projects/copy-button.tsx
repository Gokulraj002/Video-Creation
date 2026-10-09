'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Copies text to the clipboard: either the text content of the element with `targetId`, or the result of
 * `getText()` (for data held in memory, e.g. a large JSON document that is only partially rendered).
 */
export function CopyButton({
  targetId,
  getText,
  label = 'Copy',
}: {
  targetId?: string;
  getText?: () => string;
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const text = getText ? getText() : targetId ? (document.getElementById(targetId)?.textContent ?? '') : '';
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {state === 'copied' ? <Check /> : <Copy />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label}</span>
    </Button>
  );
}
