import { z } from 'zod';
import {
  DurationFramesSchema,
  FontFamilySchema,
  FrameSchema,
  HexColorSchema,
  IdSchema,
  LanguageTagSchema,
  NormalizedSchema,
} from './common';
import { OverlayContentSchema, PlaybackRateSchema } from './scene-content';

/** Track item frames are ABSOLUTE timeline frames. */
const TrackNameSchema = z.string().min(1).max(200);
const TrackVolumeSchema = z.number().min(0).max(2);

export const TrackKindSchema = z.enum(['audio', 'caption', 'overlay', 'video']);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const AudioRoleSchema = z.enum(['voiceover', 'music', 'sfx']);
export type AudioRole = z.infer<typeof AudioRoleSchema>;

export const AudioTrackItemSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  trimStartFrame: FrameSchema,
  volume: TrackVolumeSchema,
  fadeInFrames: FrameSchema,
  fadeOutFrames: FrameSchema,
});
export type AudioTrackItem = z.infer<typeof AudioTrackItemSchema>;

export const AudioTrackSchema = z.object({
  id: IdSchema,
  kind: z.literal('audio'),
  role: AudioRoleSchema,
  name: TrackNameSchema,
  muted: z.boolean(),
  volume: TrackVolumeSchema,
  items: z.array(AudioTrackItemSchema),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const CaptionStylePresetSchema = z.enum(['bold-center', 'lower', 'karaoke', 'minimal']);
export type CaptionStylePreset = z.infer<typeof CaptionStylePresetSchema>;

export const CaptionStyleSchema = z.object({
  preset: CaptionStylePresetSchema,
  position: z.enum(['bottom', 'center', 'top']),
  fontFamily: FontFamilySchema.optional(),
  fontSize: z.number().min(8).max(200).optional(),
  color: HexColorSchema,
  backgroundColor: HexColorSchema.optional(),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionItemSchema = z.object({
  id: IdSchema,
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  text: z.string().max(500),
  speaker: z.string().min(1).max(120).optional(),
});
export type CaptionItem = z.infer<typeof CaptionItemSchema>;

export const CaptionTrackSchema = z.object({
  id: IdSchema,
  kind: z.literal('caption'),
  name: TrackNameSchema,
  language: LanguageTagSchema,
  style: CaptionStyleSchema,
  items: z.array(CaptionItemSchema),
});
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;

export const OverlayItemSchema = z.object({
  id: IdSchema,
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  content: OverlayContentSchema,
  opacity: NormalizedSchema,
  zIndex: z.number().int(),
});
export type OverlayItem = z.infer<typeof OverlayItemSchema>;

export const OverlayTrackSchema = z.object({
  id: IdSchema,
  kind: z.literal('overlay'),
  name: TrackNameSchema,
  items: z.array(OverlayItemSchema),
});
export type OverlayTrack = z.infer<typeof OverlayTrackSchema>;

export const VideoTrackItemSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  trimStartFrame: FrameSchema,
  playbackRate: PlaybackRateSchema,
  opacity: NormalizedSchema,
  volume: TrackVolumeSchema,
  muted: z.boolean(),
});
export type VideoTrackItem = z.infer<typeof VideoTrackItemSchema>;

export const VideoTrackSchema = z.object({
  id: IdSchema,
  kind: z.literal('video'),
  name: TrackNameSchema,
  items: z.array(VideoTrackItemSchema),
});
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export const TrackSchema = z.discriminatedUnion('kind', [
  AudioTrackSchema,
  CaptionTrackSchema,
  OverlayTrackSchema,
  VideoTrackSchema,
]);
export type Track = z.infer<typeof TrackSchema>;
