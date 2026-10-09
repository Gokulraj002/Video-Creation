import { describe, expect, it } from 'vitest';
import { VideoRequestSchema } from '@vc/schema';
import { AIDirector, HeuristicMockProvider } from '../src/index';

describe('heuristic mock: real-estate content', () => {
  it('extracts Indian listing terms and does not repeat one feature on every scene', async () => {
    const director = new AIDirector({ provider: new HeuristicMockProvider() });
    const request = VideoRequestSchema.parse({
      title: 'Palm Grove Villas',
      prompt:
        'A 40-second real estate promo for Palm Grove Villas, Chennai OMR: 3 BHK villas from Rs 1.2 Cr, private pool, clubhouse, 10 minutes from IT parks.',
      genre: 'real-estate',
      durationSeconds: 40,
      aspectRatio: '9:16',
      resolution: '1080p',
      voiceOver: { enabled: true },
      music: { enabled: false },
    });

    const result = await director.planProject({ request });

    const showcase = result.artifacts.sceneSpecs.scenes.find((s) => s.template === 'property-showcase');
    expect(showcase?.props).toMatchObject({ price: 'Rs 1.2 Cr', features: ['Private pool', 'Clubhouse', '3 BHK'] });

    const texts = result.artifacts.storyboard.scenes.map((s) => s.onScreenText);
    for (const feature of ['3 BHK', 'Private pool', 'Clubhouse']) {
      expect(texts.filter((t) => t === feature)).toHaveLength(1);
    }
  });
});
