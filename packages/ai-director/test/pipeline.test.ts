import { describe, expect, it } from 'vitest';
import { DirectorArtifactsSchema, VideoGenreSchema, type VideoGenre } from '@vc/schema';
import { AIDirector, HeuristicMockProvider, totalStepsFor, type DirectorProgress } from '../src';
import { expectValidResult, makeReference, makeRequest } from './helpers';

const ALL_GENRES = VideoGenreSchema.options;

async function run(genre: VideoGenre, durationSeconds: number, extra: Parameters<typeof makeRequest>[0] = {}) {
  const request = makeRequest({ genre, durationSeconds, title: `${genre} test`, ...extra });
  const director = new AIDirector({ provider: new HeuristicMockProvider(), idFactory: () => 'tl-test', now: () => new Date('2026-10-09T00:00:00Z') });
  const progress: DirectorProgress[] = [];
  const references = genre === 'reference-based' ? [makeReference()] : [];
  const result = await director.planProject({ request, references }, { onProgress: (p) => void progress.push(p) });
  return { request, result, progress };
}

describe('full pipeline with the HeuristicMockProvider', () => {
  describe.each([5, 30, 600])('%s s videos', (durationSeconds) => {
    it.each(ALL_GENRES)('%s', async (genre) => {
      const { request, result, progress } = await run(genre, durationSeconds);
      expectValidResult(result, request);
      expect(DirectorArtifactsSchema.safeParse(result.artifacts).success).toBe(true);
      expect(result.plan.chunked).toBe(result.plan.chapterCount > 1);
      if (durationSeconds > 120) expect(result.plan.chapterCount).toBeGreaterThan(1);
      // Usage: one stage record per LLM step, mock pricing is free but tokens are estimated.
      const llmSteps = totalStepsFor(result.plan) - 1;
      expect(result.usage.stages).toHaveLength(llmSteps);
      expect(result.usage.totals.calls).toBe(llmSteps);
      expect(result.usage.totals.cachedCalls).toBe(0);
      expect(result.usage.totals.estimatedCostUsd).toBe(0);
      expect(result.usage.totals.inputTokens).toBeGreaterThan(0);
      expect(result.usage.stages.every((s) => s.pricingKnown && s.model === 'mock-director-v1')).toBe(true);
      // Progress ends at totalSteps.
      const last = progress[progress.length - 1];
      expect(last?.completedSteps).toBe(totalStepsFor(result.plan));
      expect(last?.totalSteps).toBe(totalStepsFor(result.plan));
      expect(result.timeline.metadata.generator).toEqual({ name: 'vc-ai-director', version: '0.1.0', promptVersion: 'm1.1' });
    });
  });

  it.each(['promo', 'long-form', 'sop-training', 'cartoon', 'real-estate'] as const)('25 min %s video is chunked and valid', async (genre) => {
    const { request, result } = await run(genre, 1500);
    expectValidResult(result, request);
    expect(result.plan.chapterCount).toBeGreaterThanOrEqual(5);
    expect(result.usage.stages.filter((s) => s.stage === 'script').map((s) => s.chunk)).toEqual(
      result.artifacts.outline.chapters.map((c) => c.id),
    );
  });

  it.each(['long-form', 'social-short', 'corporate-training'] as const)(
    '2 h %s video completes in seconds',
    async (genre) => {
      const started = Date.now();
      const { request, result } = await run(genre, 7200, { voiceOver: { enabled: true } });
      const elapsed = Date.now() - started;
      expectValidResult(result, request);
      expect(result.timeline.durationInFrames).toBe(216_000);
      expect(result.plan.chapterCount).toBeGreaterThanOrEqual(24);
      expect(elapsed).toBeLessThan(8000);
    },
    30_000,
  );

  it('is deterministic', async () => {
    const a = await run('explainer', 45);
    const b = await run('explainer', 45);
    expect(b.result.artifacts).toEqual(a.result.artifacts);
    expect(b.result.timeline).toEqual(a.result.timeline);
  });

  describe('genre-aware output', () => {
    const templatesOf = async (genre: VideoGenre, prompt?: string) => {
      const { result } = await run(genre, 60, prompt ? { prompt } : {});
      return result.artifacts.sceneSpecs.scenes.map((s) => s.template);
    };

    it('cartoon and comedy use cartoon scenes', async () => {
      const cartoon = await templatesOf('cartoon', 'A clumsy robot tries to bake a cake for his best friend.');
      expect(cartoon.filter((t) => t === 'cartoon-scene').length).toBeGreaterThanOrEqual(cartoon.length - 1);
      expect((await templatesOf('comedy')).filter((t) => t === 'cartoon-scene').length).toBeGreaterThan(5);
    });

    it('real estate uses property showcases with listing details', async () => {
      const { result } = await run('real-estate', 40, {
        prompt: 'Modern villa in Lake Como with 5 bedrooms, 4 bathrooms, a pool and a garden. Listed at €3,200,000. Book a viewing.',
      });
      const showcases = result.artifacts.sceneSpecs.scenes.filter((s) => s.template === 'property-showcase');
      expect(showcases.length).toBeGreaterThanOrEqual(2);
      expect(showcases[0]?.props.price).toBe('€3,200,000');
      expect(showcases[0]?.props.location).toBe('Lake Como');
      expect(result.artifacts.sceneSpecs.scenes.at(-1)?.template).toBe('cta-end-card');
    });

    it('SOP training uses numbered step instructions in prompt order', async () => {
      const { result } = await run('sop-training', 60, {
        prompt: 'Change a forklift battery.\n1. Park on level ground and set the brake\n2. Put on gloves and a face shield\n3. Disconnect the battery cable\n4. Lift the battery out with the hoist\n5. Install the charged battery',
      });
      const steps = result.artifacts.sceneSpecs.scenes.filter((s) => s.template === 'step-instruction');
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(steps.map((s) => s.props.stepNumber)).toEqual(steps.map((_, i) => i + 1));
      expect(String(steps[0]?.props.instruction)).toContain('Park on level ground');
      expect(result.artifacts.sceneSpecs.scenes[0]?.template).toBe('title-card');
    });

    it('3D product videos use 3D templates with 3D cameras', async () => {
      const { result } = await run('product-3d', 30);
      const three = result.timeline.scenes.filter((s) => s.content.engine === 'three');
      expect(three.length).toBeGreaterThan(0);
      expect(result.artifacts.sceneSpecs.scenes.some((s) => s.template === 'product-turntable')).toBe(true);
      for (const s of three) {
        expect(s.camera?.space).toBe('3d');
        if (s.content.engine === 'three') expect(s.content.environment).toBe('studio');
      }
      expect(result.timeline.scenes.filter((s) => s.content.engine === 'motion2d').every((s) => s.camera?.space === '2d')).toBe(true);
    });

    it('presentations use bullet lists / stats and promos close on the CTA', async () => {
      expect((await templatesOf('presentation')).some((t) => t === 'bullet-list' || t === 'stat-counter')).toBe(true);
      const promo = await templatesOf('promo');
      expect(promo[0]).toBe('title-card');
      expect(promo.at(-1)).toBe('cta-end-card');
    });
  });

  it('builds captions (≤ 7 words, contiguous per scene) only when voice-over is enabled', async () => {
    const withVo = await run('explainer', 30);
    const captionTrack = withVo.result.timeline.tracks.find((t) => t.kind === 'caption');
    expect(captionTrack).toBeDefined();
    if (captionTrack?.kind === 'caption') {
      expect(captionTrack.language).toBe('en');
      for (const item of captionTrack.items) expect(item.text.split(/\s+/).length).toBeLessThanOrEqual(7);
      for (const scene of withVo.result.timeline.scenes) {
        const cues = captionTrack.items.filter((i) => i.id.startsWith(`${scene.id}-cap`));
        expect(cues.length).toBeGreaterThan(0);
        expect(cues[0]?.startFrame).toBe(scene.startFrame);
        const end = cues.reduce((a, c) => a + c.durationInFrames, 0);
        expect(end).toBe(scene.durationInFrames);
      }
    }
    expect(withVo.result.timeline.scenes.every((s) => (s.narration?.text.length ?? 0) > 0)).toBe(true);

    const silent = await run('explainer', 30, { voiceOver: { enabled: false } });
    expect(silent.result.timeline.tracks).toEqual([]);
    expect(silent.result.timeline.scenes.every((s) => s.narration === undefined)).toBe(true);
    expect(silent.result.artifacts.script.chapters.flatMap((c) => c.segments).every((s) => s.voiceOver === null)).toBe(true);
  });

  it('maps brand colors, fonts and an available logo into the brand kit', async () => {
    const request = makeRequest({ brand: { name: 'Aurora', colors: ['#0EA5E9', '#F97316', '#111827'], fontHeading: 'Poppins', logoAssetId: 'logo-1' } });
    const director = new AIDirector({ provider: new HeuristicMockProvider() });
    const result = await director.planProject({
      request,
      assets: [{ id: 'logo-1', kind: 'image', uri: 'asset://logo-1', mimeType: 'image/png', source: 'upload' }],
    });
    expect(result.timeline.brand?.colors.primary).toBe('#0EA5E9');
    expect(result.timeline.brand?.colors.background).toBe('#111827');
    expect(result.timeline.brand?.fonts).toEqual({ heading: 'Poppins', body: 'Inter' });
    expect(result.timeline.brand?.logoAssetId).toBe('logo-1');
    expect(result.timeline.assets).toHaveLength(1);
    expect(result.artifacts.brief.visualStyle.palette.slice(0, 3)).toEqual(['#0EA5E9', '#F97316', '#111827']);

    const missingLogo = await director.planProject({ request });
    expect(missingLogo.timeline.brand?.logoAssetId).toBeUndefined();
    expect(missingLogo.warnings.some((w) => w.includes('logo-1'))).toBe(true);
  });

  it('honours aspect ratio, resolution and fps', async () => {
    const { result } = await run('social-short', 10, { aspectRatio: '9:16', resolution: '720p', fps: 24 });
    expect(result.timeline.settings).toMatchObject({ width: 720, height: 1280, fps: 24 });
    expect(result.timeline.durationInFrames).toBe(240);
  });
});
