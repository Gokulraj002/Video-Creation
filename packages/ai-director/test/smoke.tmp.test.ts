import { it } from 'vitest';
import { VideoRequestSchema } from '@vc/schema';
import { AIDirector, HeuristicMockProvider } from '../src';

const log = (...parts: unknown[]) => process.stderr.write(`\n${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`);

it('smoke', async () => {
  const cases = [
    { genre: 'cartoon', title: 'Whiskers and the Rocket', prompt: 'A curious cat builds a cardboard rocket to reach the moon. Things go hilariously wrong when the rocket lands in the neighbor\'s pool. In the end the cat discovers the moon was the reflection in the water.', durationSeconds: 20 },
    { genre: 'sop-training', title: 'Forklift Battery Change', prompt: 'Teach warehouse staff how to change a forklift battery.\n1. Park the forklift on level ground and engage the brake\n2. Put on gloves and a face shield\n3. Disconnect the battery cable\n4. Use the hoist to lift the battery out\n5. Install the charged battery and reconnect\nNever smoke near batteries.', durationSeconds: 60 },
    { genre: 'real-estate', title: 'Villa Serena', prompt: 'Luxury villa in Lake Como with 5 bedrooms, 4 bathrooms, a pool and a garden. Listed at €3,200,000. Book a private viewing at villaserena.com', durationSeconds: 25 },
  ] as const;
  for (const c of cases) {
    const request = VideoRequestSchema.parse({ ...c, aspectRatio: '9:16', resolution: '1080p', voiceOver: { enabled: true }, music: { enabled: true }, brand: { name: 'Acme', colors: ['#FF5500'] } });
    const r = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request });
    log('=====', c.genre, 'brief', r.artifacts.brief);
    for (const s of r.artifacts.storyboard.scenes) {
      const spec = r.artifacts.sceneSpecs.scenes.find((x) => x.sceneId === s.id);
      log('--', s.id, s.durationSeconds.toFixed(2), s.title, '|', s.voiceOver, '|', spec?.template, spec?.props, spec?.cameraPreset);
    }
    log('captions', r.timeline.tracks[0]?.kind, r.timeline.tracks[0] && 'items' in r.timeline.tracks[0] ? r.timeline.tracks[0].items.slice(0, 3) : null);
    log('brand', r.timeline.brand, 'usage', r.usage.totals);
  }
}, 600000);
