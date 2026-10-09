import { formatTimecode, type BrandColors, type CaptionItem, type CaptionTrack, type Scene, type Timeline } from '@vc/schema';
import type { CSSProperties } from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  activeCaption,
  easeInOut,
  findSpanIndex,
  primaryCaptionTrack,
  primaryTemplateText,
  readableTextColor,
  resolveBrandColors,
  sceneColors,
  secondaryTemplateLines,
  transitionFrames,
  transitionProgress,
} from '@/lib/animatic';
import { ENGINE_LABELS } from '@/lib/options';

/**
 * Remotion composition for the storyboard animatic. Every scene is a branded card rendered inside
 * `<Sequence from={scene.startFrame} durationInFrames={scene.durationInFrames}>` using the timeline's integer
 * frames; only the scenes around the playhead are mounted so multi-hour timelines stay cheap.
 */
export type AnimaticProps = {
  timeline: Timeline;
};

function fontStack(family: string | undefined): string {
  const base = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  return family ? `"${family}", ${base}` : base;
}

interface SlideContext {
  brand: BrandColors;
  headingFont: string;
  bodyFont: string;
  chapterTitle: string | null;
  sceneNumber: number;
  sceneCount: number;
  fps: number;
}

/** A scene card frozen at `localFrame` (scene-relative), so it can also be drawn as the outgoing "ghost". */
function SceneSlide({ scene, localFrame, ctx }: { scene: Scene; localFrame: number; ctx: SlideContext }) {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const colors = sceneColors(scene.content, ctx.brand);
  const fg = readableTextColor(colors.background);
  const primary = primaryTemplateText(scene.content, scene.title);
  const secondary = secondaryTemplateLines(scene.content);
  const content = scene.content;
  const engineLabel = ENGINE_LABELS[content.engine];
  const badge =
    content.engine === 'motion2d' || content.engine === 'three'
      ? `${engineLabel} · ${content.template}`
      : `${engineLabel} · placeholder`;

  const enter = easeInOut(interpolate(localFrame, [0, Math.min(18, scene.durationInFrames)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const secondaryEnter = easeInOut(
    interpolate(localFrame, [6, Math.min(26, Math.max(7, scene.durationInFrames))], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const sceneProgress = Math.min(1, Math.max(0, (localFrame + 1) / scene.durationInFrames));
  const primarySize = (primary.length > 140 ? 40 : primary.length > 70 ? 52 : primary.length > 32 ? 64 : 80) * unit;

  const background: CSSProperties['background'] = colors.gradient
    ? `linear-gradient(135deg, ${colors.gradient.join(', ')})`
    : `radial-gradient(120% 120% at 0% 0%, ${colors.accent}33 0%, ${colors.background} 55%)`;

  return (
    <AbsoluteFill style={{ background, backgroundColor: colors.background, color: fg, fontFamily: ctx.bodyFont }}>
      {/* Header: chapter + scene counter, engine badge */}
      <div
        style={{
          position: 'absolute',
          top: 48 * unit,
          left: 56 * unit,
          right: 56 * unit,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 24 * unit,
          fontSize: 22 * unit,
          letterSpacing: 2 * unit,
          textTransform: 'uppercase',
          opacity: 0.85,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ctx.chapterTitle ? `${ctx.chapterTitle} · ` : ''}Scene {ctx.sceneNumber}/{ctx.sceneCount}
        </span>
        <span
          style={{
            flexShrink: 0,
            padding: `${8 * unit}px ${18 * unit}px`,
            borderRadius: 999,
            background: colors.accent,
            color: readableTextColor(colors.accent),
            fontWeight: 700,
            letterSpacing: 1 * unit,
            textTransform: 'none',
          }}
        >
          {badge}
        </span>
      </div>

      {/* Body */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          padding: `${150 * unit}px ${96 * unit}px`,
          gap: 28 * unit,
        }}
      >
        <div
          style={{
            width: 96 * unit,
            height: 10 * unit,
            borderRadius: 999,
            background: colors.accent,
            transform: `scaleX(${enter})`,
            transformOrigin: 'left center',
          }}
        />
        <div
          style={{
            fontFamily: ctx.headingFont,
            fontSize: primarySize,
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: -0.5 * unit,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 40 * unit}px)`,
            display: '-webkit-box',
            WebkitLineClamp: 5,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {primary}
        </div>
        {secondary.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12 * unit,
              fontSize: 32 * unit,
              lineHeight: 1.3,
              opacity: secondaryEnter * 0.92,
              transform: `translateY(${(1 - secondaryEnter) * 24 * unit}px)`,
            }}
          >
            {secondary.map((line, i) => (
              <div key={i} style={{ display: 'flex', gap: 16 * unit, alignItems: 'baseline' }}>
                {secondary.length > 1 ? (
                  <span style={{ color: colors.accent, fontWeight: 800 }}>{'•'}</span>
                ) : null}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</span>
              </div>
            ))}
          </div>
        ) : null}
      </AbsoluteFill>

      {/* Footer: scene title + timecode, scene progress */}
      <div
        style={{
          position: 'absolute',
          left: 56 * unit,
          right: 56 * unit,
          bottom: 44 * unit,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 24 * unit,
          fontSize: 22 * unit,
          opacity: 0.75,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scene.title}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatTimecode(scene.startFrame, ctx.fps)}
        </span>
      </div>
      <div style={{ position: 'absolute', left: 0, bottom: 0, height: 6 * unit, width: '100%', background: `${fg}22` }}>
        <div style={{ height: '100%', width: `${sceneProgress * 100}%`, background: colors.accent }} />
      </div>
    </AbsoluteFill>
  );
}

/** Scene inside its Sequence: applies the incoming transition over the frozen previous scene. */
function SceneWithTransition({ scene, previous, ctx, previousCtx }: { scene: Scene; previous: Scene | null; ctx: SlideContext; previousCtx: SlideContext | null }) {
  const frame = useCurrentFrame(); // relative to the Sequence
  const frames = transitionFrames(scene.transitionIn, scene.durationInFrames);
  const p = easeInOut(transitionProgress(frame, frames));
  const type = scene.transitionIn?.type ?? 'cut';
  const inTransition = frames > 0 && frame < frames && previous !== null && previousCtx !== null;

  let incoming: CSSProperties = {};
  let ghostOpacity = 0;
  let dipColor: string | null = null;
  let dipOpacity = 0;

  if (inTransition) {
    switch (type) {
      case 'fade':
      case 'crossfade':
        incoming = { opacity: p };
        ghostOpacity = 1;
        break;
      case 'dip-to-black':
      case 'dip-to-white':
        dipColor = type === 'dip-to-black' ? '#000000' : '#ffffff';
        ghostOpacity = p < 0.5 ? 1 : 0;
        incoming = { opacity: p < 0.5 ? 0 : 1 };
        dipOpacity = p < 0.5 ? p * 2 : (1 - p) * 2;
        break;
      case 'slide': {
        const dir = scene.transitionIn?.direction ?? 'left';
        const offset = (1 - p) * 100;
        const translate =
          dir === 'left' ? `translateX(${offset}%)` : dir === 'right' ? `translateX(-${offset}%)` : dir === 'up' ? `translateY(${offset}%)` : `translateY(-${offset}%)`;
        incoming = { transform: translate };
        ghostOpacity = 1;
        break;
      }
      case 'wipe': {
        const dir = scene.transitionIn?.direction ?? 'left';
        const hidden = (1 - p) * 100;
        const inset =
          dir === 'left' ? `inset(0 0 0 ${hidden}%)` : dir === 'right' ? `inset(0 ${hidden}% 0 0)` : dir === 'up' ? `inset(${hidden}% 0 0 0)` : `inset(0 0 ${hidden}% 0)`;
        incoming = { clipPath: inset };
        ghostOpacity = 1;
        break;
      }
      case 'zoom':
        incoming = { opacity: p, transform: `scale(${1.15 - 0.15 * p})` };
        ghostOpacity = 1;
        break;
      case 'blur':
        incoming = { opacity: p, filter: `blur(${(1 - p) * 24}px)` };
        ghostOpacity = 1;
        break;
      default:
        break;
    }
  }

  return (
    <AbsoluteFill>
      {inTransition && previous && previousCtx && ghostOpacity > 0 ? (
        <AbsoluteFill style={{ opacity: ghostOpacity }}>
          <SceneSlide scene={previous} localFrame={previous.durationInFrames - 1} ctx={previousCtx} />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={incoming}>
        <SceneSlide scene={scene} localFrame={frame} ctx={ctx} />
      </AbsoluteFill>
      {dipColor ? <AbsoluteFill style={{ backgroundColor: dipColor, opacity: dipOpacity }} /> : null}
    </AbsoluteFill>
  );
}

function CaptionCue({ cue, track }: { cue: CaptionItem; track: CaptionTrack }) {
  const frame = useCurrentFrame(); // relative to the cue's Sequence
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const fadeFrames = Math.min(4, Math.max(1, Math.floor(cue.durationInFrames / 3)));
  const opacity = interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const { style } = track;
  const preset = style.preset;
  const fontSize = (style.fontSize ?? (preset === 'bold-center' ? 54 : preset === 'minimal' ? 34 : 42)) * unit;
  const justify = style.position === 'top' ? 'flex-start' : style.position === 'center' ? 'center' : 'flex-end';

  return (
    <AbsoluteFill
      style={{
        justifyContent: justify,
        alignItems: 'center',
        padding: `${(style.position === 'center' ? 0 : 120) * unit}px ${80 * unit}px`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: '88%',
          textAlign: 'center',
          fontFamily: fontStack(style.fontFamily),
          fontSize,
          fontWeight: preset === 'minimal' ? 500 : 800,
          lineHeight: 1.25,
          color: style.color,
          background: style.backgroundColor ?? (preset === 'minimal' ? 'transparent' : 'rgba(0,0,0,0.55)'),
          padding: preset === 'minimal' ? 0 : `${10 * unit}px ${22 * unit}px`,
          borderRadius: 14 * unit,
          textShadow: preset === 'minimal' ? '0 2px 8px rgba(0,0,0,0.6)' : undefined,
          opacity,
        }}
      >
        {cue.speaker ? <span style={{ opacity: 0.7 }}>{cue.speaker}: </span> : null}
        {cue.text}
      </div>
    </AbsoluteFill>
  );
}

export function AnimaticComposition({ timeline }: AnimaticProps) {
  const frame = useCurrentFrame();
  const brand = resolveBrandColors(timeline);
  const headingFont = fontStack(timeline.brand?.fonts.heading);
  const bodyFont = fontStack(timeline.brand?.fonts.body);
  const chapters = new Map(timeline.chapters.map((c) => [c.id, c.title]));
  const { scenes } = timeline;
  const fps = timeline.settings.fps;

  const current = Math.max(0, findSpanIndex(scenes, frame));
  const mounted = [current - 1, current, current + 1].filter((i) => i >= 0 && i < scenes.length);

  const ctxFor = (index: number): SlideContext | null => {
    const scene = scenes[index];
    if (!scene) return null;
    return {
      brand,
      headingFont,
      bodyFont,
      chapterTitle: timeline.chapters.length > 1 ? (chapters.get(scene.chapterId) ?? null) : null,
      sceneNumber: index + 1,
      sceneCount: scenes.length,
      fps,
    };
  };

  const captionTrack = primaryCaptionTrack(timeline);
  const cue = activeCaption(captionTrack, frame);

  return (
    <AbsoluteFill style={{ backgroundColor: timeline.settings.backgroundColor }}>
      {mounted.map((index) => {
        const scene = scenes[index];
        const ctx = ctxFor(index);
        if (!scene || !ctx) return null;
        return (
          <Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.durationInFrames} name={scene.title}>
            <SceneWithTransition scene={scene} previous={scenes[index - 1] ?? null} ctx={ctx} previousCtx={ctxFor(index - 1)} />
          </Sequence>
        );
      })}
      {captionTrack && cue ? (
        <Sequence key={cue.id} from={cue.startFrame} durationInFrames={cue.durationInFrames} name="Caption">
          <CaptionCue cue={cue} track={captionTrack} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
}
