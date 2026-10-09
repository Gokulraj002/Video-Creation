import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export type PersonalizedIntroProps = {
  headline: string;
  subline: string;
  brandName: string;
  brandColor: string;
  logoUrl?: string;
  durationInSeconds?: number;
};

export const defaultIntroProps: PersonalizedIntroProps = {
  headline: 'Hi Asha!',
  subline: 'We have something special for you in Chennai',
  brandName: 'Your Brand',
  brandColor: '#4f46e5',
};

export const PersonalizedIntro: React.FC<PersonalizedIntroProps> = ({
  headline,
  subline,
  brandName,
  brandColor,
  logoUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const pop = spring({ frame, fps, config: { damping: 12 } });
  const sublineIn = spring({ frame: frame - 15, fps, config: { damping: 200 } });
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${brandColor} 0%, #0f172a 100%)`,
        fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
        color: 'white',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 90,
        opacity: fadeOut,
      }}
    >
      {logoUrl ? (
        <Img src={logoUrl} style={{ position: 'absolute', top: 160, height: 140, objectFit: 'contain' }} />
      ) : null}

      <div
        style={{
          fontSize: 130,
          fontWeight: 800,
          lineHeight: 1.05,
          textAlign: 'center',
          transform: `scale(${pop})`,
        }}
      >
        {headline}
      </div>

      <div
        style={{
          marginTop: 60,
          fontSize: 62,
          fontWeight: 500,
          lineHeight: 1.3,
          textAlign: 'center',
          opacity: sublineIn,
          transform: `translateY(${(1 - sublineIn) * 40}px)`,
        }}
      >
        {subline}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 160,
          fontSize: 44,
          fontWeight: 600,
          letterSpacing: 4,
          textTransform: 'uppercase',
          opacity: 0.85,
        }}
      >
        {brandName}
      </div>
    </AbsoluteFill>
  );
};
