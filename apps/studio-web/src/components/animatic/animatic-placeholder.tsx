import type { ReactNode } from 'react';

/** Box with the player's size (so nothing jumps when the Player mounts), showing a status line. */
export function AnimaticPlaceholder({
  width,
  height,
  label,
  pulse = true,
  children,
}: {
  width: number;
  height: number;
  label: string;
  pulse?: boolean;
  children?: ReactNode;
}) {
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  return (
    <div
      role="status"
      className={`mx-auto flex w-full flex-col items-center justify-center gap-3 rounded-lg border bg-muted p-4 text-center text-sm text-muted-foreground ${pulse ? 'animate-pulse' : ''}`}
      style={{ aspectRatio: String(ratio), maxWidth: `min(100%, calc(70vh * ${ratio}))` }}
    >
      <span>{label}</span>
      {children}
    </div>
  );
}
