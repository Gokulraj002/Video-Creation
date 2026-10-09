import {
  AbsoluteFill,
  interpolate,
  interpolateColors,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type TravelOfferProps = {
  name: string;
  destination: string;
  tripTitle: string;
  highlight1: string;
  highlight2: string;
  highlight3: string;
  price: string;
  oldPrice: string;
  priceNote: string;
  ctaText: string;
  validTill: string;
  brandName: string;
  brandColor: string;
  /** Scene start points as fractions of the length, e.g. "0.2,0.49,0.735"; tune to the voice-over */
  sceneSplits?: string;
  durationInSeconds?: number;
};

export const defaultTravelOfferProps: TravelOfferProps = {
  name: 'Asha',
  destination: 'Kerala',
  tripTitle: '5 Days · Munnar + Alleppey',
  highlight1: 'Private houseboat stay',
  highlight2: 'Tea garden sunrise tour',
  highlight3: 'Hotel + transfers included',
  price: '₹24,999',
  oldPrice: '₹32,999',
  priceNote: 'per person · twin sharing',
  ctaText: 'Reply YES on WhatsApp',
  validTill: 'Offer valid till 31 Oct',
  brandName: 'Your Travel Co',
  brandColor: '#0f766e',
};

// Scene boundaries are fractions of the total length, so the video stretches
// with the voice-over without retiming every scene.
const DEFAULT_SPLITS: [number, number, number] = [0.2, 0.49, 0.735];
const FADE = 10;

function parseSplits(input?: string): [number, number, number] {
  const n = (input ?? '').split(',').map(Number);
  const valid = n.length === 3 && n.every((x, i) => x > 0 && x < 1 && (i === 0 || x > n[i - 1]!));
  return valid ? (n as [number, number, number]) : DEFAULT_SPLITS;
}

const textShadow = '0 6px 30px rgba(0,0,0,0.35)';

function Scene({ range, children }: { range: readonly [number, number]; children: React.ReactNode }) {
  const { durationInFrames } = useVideoConfig();
  const from = Math.round(range[0] * durationInFrames);
  const length = Math.round(range[1] * durationInFrames) - from;
  return (
    <Sequence from={from} durationInFrames={length}>
      <SceneFade length={length} last={range[1] === 1}>
        {children}
      </SceneFade>
    </Sequence>
  );
}

function SceneFade({ length, last, children }: { length: number; last: boolean; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, FADE], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = last ? 1 : interpolate(frame, [length - FADE, length], [1, 0], { extrapolateLeft: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut), transform: `translateY(${(1 - fadeIn) * 40}px)` }}>
      {children}
    </AbsoluteFill>
  );
}

function usePop(delay = 0, damping = 12) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping } });
}

function Landscape() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const sunY = interpolate(frame, [0, durationInFrames * 0.3], [1500, 1290], { extrapolateRight: 'clamp' });
  const drift = (frame * 0.6) % 540;
  const wave = (frame * 2.2) % 360;

  return (
    <AbsoluteFill>
      <svg width="1080" height="1920" viewBox="0 0 1080 1920">
        <circle cx="760" cy={sunY} r="120" fill="#ffd27a" opacity="0.95" />
        <circle cx="760" cy={sunY} r="185" fill="#ffd27a" opacity="0.18" />
        {/* Far hills */}
        <path
          transform={`translate(${-drift * 0.3}, 0)`}
          d="M-200 1330 C 0 1180, 180 1200, 360 1300 S 720 1160, 900 1260 S 1240 1180, 1500 1290 L 1500 1920 L -200 1920 Z"
          fill="#2f7d6b"
          opacity="0.75"
        />
        {/* Near hills with tea-garden rows */}
        <path
          transform={`translate(${-drift * 0.6}, 0)`}
          d="M-300 1450 C -60 1330, 160 1360, 380 1440 S 760 1340, 980 1420 S 1400 1350, 1700 1440 L 1700 1920 L -300 1920 Z"
          fill="#1f5f4f"
        />
        {/* Backwaters */}
        <rect x="0" y="1560" width="1080" height="360" fill="#0d4f5c" />
        {[0, 1, 2, 3].map((i) => (
          <path
            key={i}
            transform={`translate(${-wave + (i % 2) * 90}, ${1600 + i * 75})`}
            d={`M0 0 ${Array.from({ length: 9 }, (_, k) => `q 45 -14 90 0 t 90 0`).join(' ')}`}
            stroke="#5fb3b3"
            strokeOpacity={0.45 - i * 0.08}
            strokeWidth="5"
            fill="none"
          />
        ))}
        {/* Palm silhouette */}
        <g transform="translate(140, 1180)" fill="#0b3b36">
          <path d="M60 420 C 70 300, 80 180, 105 60 L 120 62 C 100 180, 92 300, 88 420 Z" />
          {[-60, -25, 15, 50, 85].map((angle) => (
            <ellipse key={angle} cx="112" cy="60" rx="120" ry="22" transform={`rotate(${angle} 112 60) translate(80 0)`} />
          ))}
        </g>
      </svg>
    </AbsoluteFill>
  );
}

function BrandBar({ brandName, brandColor }: { brandName: string; brandColor: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 110,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 22,
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          background: 'white',
          color: brandColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 40,
          fontWeight: 800,
        }}
      >
        {brandName.trim().charAt(0).toUpperCase()}
      </div>
      <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', textShadow }}>
        {brandName}
      </div>
    </div>
  );
}

function Greeting({ name, destination }: Pick<TravelOfferProps, 'name' | 'destination'>) {
  const pop = usePop();
  const sub = usePop(14, 200);
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 470, paddingLeft: 80, paddingRight: 80 }}>
      <div style={{ fontSize: 170, fontWeight: 800, transform: `scale(${pop})`, textShadow, textAlign: 'center' }}>
        Hi {name}!
      </div>
      <div
        style={{
          marginTop: 40,
          fontSize: 70,
          fontWeight: 600,
          textAlign: 'center',
          lineHeight: 1.25,
          opacity: sub,
          transform: `translateY(${(1 - sub) * 30}px)`,
          textShadow,
        }}
      >
        Your {destination} getaway
        <br />
        is ready
      </div>
    </AbsoluteFill>
  );
}

function Trip({ tripTitle, highlight1, highlight2, highlight3 }: TravelOfferProps) {
  const card = usePop(0, 200);
  const highlights = [highlight1, highlight2, highlight3].filter((h) => h.trim());
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 360 }}>
      <div
        style={{
          width: 900,
          padding: '64px 60px',
          borderRadius: 48,
          background: 'rgba(255,255,255,0.14)',
          border: '2px solid rgba(255,255,255,0.28)',
          backdropFilter: 'blur(12px)',
          transform: `scale(${0.9 + card * 0.1})`,
          opacity: card,
        }}
      >
        <div style={{ fontSize: 40, fontWeight: 600, opacity: 0.85, letterSpacing: 2, textTransform: 'uppercase' }}>
          Your trip
        </div>
        <div style={{ marginTop: 12, fontSize: 76, fontWeight: 800, lineHeight: 1.1 }}>{tripTitle}</div>
        <div style={{ marginTop: 44, display: 'grid', gap: 26 }}>
          {highlights.map((h, i) => (
            <Highlight key={h} text={h} delay={12 + i * 12} />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Highlight({ text, delay }: { text: string; delay: number }) {
  const p = usePop(delay, 200);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 26,
        fontSize: 52,
        fontWeight: 600,
        opacity: p,
        transform: `translateX(${(1 - p) * -60}px)`,
      }}
    >
      <svg width="58" height="58" viewBox="0 0 58 58">
        <circle cx="29" cy="29" r="29" fill="#ffd27a" />
        <path d="M17 30 L26 39 L42 21" stroke="#0b3b36" strokeWidth="6" fill="none" strokeLinecap="round" />
      </svg>
      {text}
    </div>
  );
}

function Price({ price, oldPrice, priceNote }: Pick<TravelOfferProps, 'price' | 'oldPrice' | 'priceNote'>) {
  const label = usePop(0, 200);
  const big = usePop(8, 10);
  const note = usePop(22, 200);
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 480, textShadow }}>
      <div style={{ fontSize: 64, fontWeight: 600, opacity: label }}>Starting at just</div>
      {oldPrice.trim() ? (
        <div
          style={{
            marginTop: 20,
            fontSize: 72,
            fontWeight: 600,
            opacity: 0.7 * label,
            textDecoration: 'line-through',
            textDecorationThickness: 6,
          }}
        >
          {oldPrice}
        </div>
      ) : null}
      <div style={{ fontSize: 230, fontWeight: 900, lineHeight: 1.05, color: '#ffd27a', transform: `scale(${big})` }}>
        {price}
      </div>
      <div style={{ marginTop: 10, fontSize: 50, fontWeight: 500, opacity: note }}>{priceNote}</div>
    </AbsoluteFill>
  );
}

function Cta({ ctaText, validTill }: Pick<TravelOfferProps, 'ctaText' | 'validTill'>) {
  const frame = useCurrentFrame();
  const pop = usePop(0, 11);
  const pulse = 1 + Math.sin(frame / 6) * 0.025;
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 560 }}>
      <div style={{ fontSize: 66, fontWeight: 700, textShadow, marginBottom: 50 }}>Want this trip?</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          background: '#25D366',
          color: '#073b1f',
          padding: '40px 64px',
          borderRadius: 999,
          fontSize: 62,
          fontWeight: 800,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          transform: `scale(${pop * pulse})`,
        }}
      >
        <svg width="70" height="70" viewBox="0 0 32 32">
          <path
            fill="#073b1f"
            d="M16 3C9 3 3.3 8.6 3.3 15.6c0 2.4.7 4.7 1.9 6.7L3 29l6.9-2.1c1.9 1 4 1.6 6.1 1.6 7 0 12.7-5.7 12.7-12.6S23 3 16 3zm0 23.1c-1.9 0-3.8-.5-5.4-1.5l-.4-.2-4.1 1.2 1.2-4-.3-.4c-1.1-1.7-1.7-3.6-1.7-5.6C5.3 9.8 10.1 5.1 16 5.1s10.7 4.7 10.7 10.5S21.9 26.1 16 26.1zm5.9-7.9c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.3.3-.6.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.2 1.4 3.5c.2.2 2.4 3.6 5.8 5 .8.4 1.4.6 1.9.7.8.3 1.6.2 2.2.1.7-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z"
          />
        </svg>
        {ctaText}
      </div>
      <div style={{ marginTop: 56, fontSize: 46, fontWeight: 500, opacity: 0.9, textShadow }}>{validTill}</div>
    </AbsoluteFill>
  );
}

export const TravelOffer: React.FC<TravelOfferProps> = (props) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const [a, b, c] = parseSplits(props.sceneSplits);
  const scenes = { greet: [0, a], trip: [a, b], price: [b, c], cta: [c, 1] } as const;
  const stops = [0, d * a, d * b, d * c, d];
  const top = interpolateColors(frame, stops, ['#ff8a5b', '#f97b62', props.brandColor, '#123c4a', '#0b2a3a']);
  const bottom = interpolateColors(frame, stops, ['#ffc078', '#ffb38a', '#1c8f86', props.brandColor, '#0f4c5c']);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, ${top} 0%, ${bottom} 70%)`,
        color: 'white',
        fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <Landscape />
      <BrandBar brandName={props.brandName} brandColor={props.brandColor} />
      <Scene range={scenes.greet}>
        <Greeting name={props.name} destination={props.destination} />
      </Scene>
      <Scene range={scenes.trip}>
        <Trip {...props} />
      </Scene>
      <Scene range={scenes.price}>
        <Price price={props.price} oldPrice={props.oldPrice} priceNote={props.priceNote} />
      </Scene>
      <Scene range={scenes.cta}>
        <Cta ctaText={props.ctaText} validTill={props.validTill} />
      </Scene>
    </AbsoluteFill>
  );
};
