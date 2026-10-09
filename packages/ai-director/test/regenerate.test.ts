import { describe, expect, it } from 'vitest';
import { AIDirector, DirectorError, HeuristicMockProvider } from '../src';
import { delegatingProvider, expectValidResult, makeRequest } from './helpers';

describe('regenerateScene', () => {
  it('re-plans one scene, keeps its id and timing, and leaves every other scene identical', async () => {
    const request = makeRequest({ genre: 'promo', durationSeconds: 40 });
    const base = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request });
    const scenes = base.artifacts.storyboard.scenes;
    const target = scenes[Math.floor(scenes.length / 2)];
    if (!target) throw new Error('no scene');

    const provider = delegatingProvider();
    const progress: string[] = [];
    const result = await new AIDirector({ provider }).regenerateScene(
      { request, artifacts: base.artifacts, sceneId: target.id, instructions: 'Make it punchier with the line "Glow up your hydration"' },
      { onProgress: (p) => void progress.push(`${p.stage}:${p.completedSteps}/${p.totalSteps}`) },
    );
    expectValidResult(result, request);

    // Only the four per-scene stages ran, chunked by the scene id.
    expect(provider.calls.map((c) => c.stage)).toEqual(['storyboard', 'shotList', 'engineSelection', 'sceneSpecs']);
    expect(provider.calls.every((c) => c.chunk === target.id)).toBe(true);
    expect(provider.calls[0]?.prompt).toContain('Glow up your hydration');
    expect(result.usage.stages.map((s) => s.chunk)).toEqual([target.id, target.id, target.id, target.id]);
    expect(progress.at(-1)).toBe('compile:5/5');

    // Same ids, same timing for every scene.
    const before = base.timeline.scenes;
    const after = result.timeline.scenes;
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.map((s) => [s.startFrame, s.durationInFrames])).toEqual(before.map((s) => [s.startFrame, s.durationInFrames]));
    expect(result.timeline.chapters).toEqual(base.timeline.chapters);

    // Other scenes untouched (timeline + artifacts), the target changed.
    for (let i = 0; i < before.length; i++) {
      if (before[i]?.id === target.id) continue;
      expect(after[i]).toEqual(before[i]);
    }
    const sceneIndex = scenes.findIndex((s) => s.id === target.id);
    const newStoryboard = result.artifacts.storyboard.scenes[sceneIndex];
    expect(newStoryboard?.id).toBe(target.id);
    expect(newStoryboard?.durationSeconds).toBe(target.durationSeconds);
    expect(newStoryboard?.title).toBe('Glow up your hydration');
    expect(newStoryboard).not.toEqual(target);
    expect(result.artifacts.storyboard.scenes.filter((s) => s.id !== target.id)).toEqual(scenes.filter((s) => s.id !== target.id));
    expect(result.artifacts.sceneSpecs.scenes.filter((s) => s.sceneId !== target.id)).toEqual(
      base.artifacts.sceneSpecs.scenes.filter((s) => s.sceneId !== target.id),
    );
    expect(result.artifacts.brief).toEqual(base.artifacts.brief);
    expect(result.artifacts.script).toEqual(base.artifacts.script);

    // Captions of the other scenes are unchanged.
    const caps = (t: typeof base.timeline) =>
      t.tracks.flatMap((tr) => (tr.kind === 'caption' ? tr.items : [])).filter((c) => !c.id.startsWith(`${target.id}-cap`));
    expect(caps(result.timeline)).toEqual(caps(base.timeline));
  });

  it('works for the first scene of a multi-chapter video', async () => {
    const request = makeRequest({ genre: 'long-form', durationSeconds: 400 });
    const base = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request });
    const first = base.artifacts.storyboard.scenes[0];
    if (!first) throw new Error('no scene');
    const result = await new AIDirector({ provider: new HeuristicMockProvider() }).regenerateScene({ request, artifacts: base.artifacts, sceneId: first.id });
    expectValidResult(result, request);
    expect(result.artifacts.storyboard.scenes[0]?.transitionIn).toBe('cut');
    expect(result.timeline.scenes.slice(1)).toEqual(base.timeline.scenes.slice(1));
  });

  it('rejects unknown scene ids and invalid artifacts', async () => {
    const request = makeRequest();
    const base = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request });
    const director = new AIDirector({ provider: new HeuristicMockProvider() });
    await expect(director.regenerateScene({ request, artifacts: base.artifacts, sceneId: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const broken = { ...base.artifacts, brief: { title: 'missing everything else' } } as unknown as typeof base.artifacts;
    const err = await director.regenerateScene({ request, artifacts: broken, sceneId: 'c1-s1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectorError);
    expect((err as DirectorError).code).toBe('VALIDATION_FAILED');
  });
});
