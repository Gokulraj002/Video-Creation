'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Copies the text content of the element with `targetId` (avoids shipping large payloads twice). */
export function CopyButton({ targetId, label = 'Copy' }: { targetId: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copy = async () => {
    const text = document.getElementById(targetId)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {state === 'copied' ? <Check /> : <Copy />}
      {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label}
    </Button>
  );
}
