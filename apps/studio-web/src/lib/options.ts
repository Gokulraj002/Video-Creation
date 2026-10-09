import type { AspectRatio, EngineType, Resolution, VideoGenre, VoiceGender } from '@vc/schema';

/** UI vocabulary for the project form and badges (values come from @vc/schema enums). */

export const GENRE_OPTIONS: readonly { value: VideoGenre; label: string; hint: string }[] = [
  { value: 'explainer', label: 'Explainer', hint: 'Clear, step-by-step concept explanation' },
  { value: 'promo', label: 'Promo', hint: 'Energetic product or event promotion' },
  { value: 'cinematic-ad', label: 'Cinematic ad', hint: 'Short, punchy, premium brand spot' },
  { value: 'social-short', label: 'Social short', hint: 'Fast vertical content for feeds' },
  { value: 'motion-graphics', label: 'Motion graphics', hint: 'Kinetic type and animated shapes' },
  { value: 'product-3d', label: 'Product 3D', hint: '3D product turntables and reveals' },
  { value: 'real-estate', label: 'Real estate', hint: 'Property showcase with features and price' },
  { value: 'sop-training', label: 'SOP training', hint: 'Numbered procedural steps with cautions' },
  { value: 'corporate-training', label: 'Corporate training', hint: 'Calm, structured learning modules' },
  { value: 'presentation', label: 'Presentation', hint: 'Slide-like sections with bullets and stats' },
  { value: 'comedy', label: 'Comedy', hint: 'Playful timing with cartoon gags' },
  { value: 'cartoon', label: 'Cartoon', hint: 'Character-driven animated scenes' },
  { value: 'long-form', label: 'Long-form', hint: 'Chaptered documentaries and courses' },
  { value: 'reference-based', label: 'Reference-based', hint: 'Match the pacing of a reference video' },
];

export const ASPECT_RATIO_OPTIONS: readonly { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '16:9 · Landscape' },
  { value: '9:16', label: '9:16 · Vertical' },
  { value: '1:1', label: '1:1 · Square' },
  { value: '4:5', label: '4:5 · Portrait' },
  { value: 'custom', label: 'Custom W × H' },
];

export const RESOLUTION_OPTIONS: readonly { value: Resolution; label: string }[] = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p (HD)' },
  { value: '1080p', label: '1080p (Full HD)' },
  { value: '1440p', label: '1440p (QHD)' },
  { value: '2160p', label: '2160p (4K)' },
  { value: 'custom', label: 'Custom' },
];

export const VOICE_GENDER_OPTIONS: readonly { value: VoiceGender | 'any'; label: string }[] = [
  { value: 'any', label: 'No preference' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'neutral', label: 'Neutral' },
];

export const LANGUAGE_SUGGESTIONS: readonly { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh-Hans', label: 'Chinese (Simplified)' },
  { value: 'ar', label: 'Arabic' },
];

export const ENGINE_LABELS: Readonly<Record<EngineType, string>> = {
  motion2d: '2D motion',
  three: '3D',
  footage: 'Footage',
  generated: 'Generated video',
  image: 'Image',
  screen: 'Screen recording',
};

export function genreLabel(genre: VideoGenre): string {
  return GENRE_OPTIONS.find((g) => g.value === genre)?.label ?? genre;
}
