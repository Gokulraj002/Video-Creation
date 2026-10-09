import { CancelledError, InternalDirectorError } from '../errors';
import { estimateTokens, type AIProvider, type StructuredGenerationRequest, type StructuredGenerationResult } from '../provider';
import type {
  BriefStageInput,
  EngineSelectionStageInput,
  OutlineStageInput,
  SceneSpecsStageInput,
  ScriptStageInput,
  ShotListStageInput,
  StoryboardStageInput,
} from '../stages';
import { isRecord } from '../util/json';
import { mockBrief, mockChapterScript, mockChapterShotList, mockChapterStoryboard, mockOutline } from './heuristic/stages';
import { mockChapterEngineSelection, mockChapterSceneSpecs } from './heuristic/visuals';

export const HEURISTIC_MOCK_MODEL = 'mock-director-v1';

/**
 * Deterministic, genre-aware provider that builds schema-valid AND semantically valid output for every stage
 * from the structured stage input. The default provider (`AI_PROVIDER=mock`): the studio works end-to-end
 * without spending credits. Usage is estimated (chars / 4) so the UI shows realistic numbers; cost is 0.
 */
export class HeuristicMockProvider implements AIProvider {
  readonly name = 'mock';
  readonly model = HEURISTIC_MOCK_MODEL;
  readonly mode = 'mock' as const;

  async generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    const started = Date.now();
    if (req.signal?.aborted) throw new CancelledError();
    if (!isRecord(req.input)) throw new InternalDirectorError(`Mock provider received no structured input for stage "${req.stage}"`);
    const output = this.build(req.stage, req.input);
    const outputText = JSON.stringify(output);
    return {
      output,
      usage: {
        inputTokens: estimateTokens(req.system) + estimateTokens(req.prompt),
        outputTokens: estimateTokens(outputText),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      provider: this.name,
      model: this.model,
      stopReason: 'end_turn',
      latencyMs: Date.now() - started,
    };
  }

  /** The director is the only producer of stage inputs; they are plain JSON built from validated data. */
  private build(stage: string, input: Record<string, unknown>): unknown {
    switch (stage) {
      case 'brief':
        return mockBrief(input as unknown as BriefStageInput);
      case 'outline':
        return mockOutline(input as unknown as OutlineStageInput);
      case 'script':
        return mockChapterScript(input as unknown as ScriptStageInput);
      case 'storyboard':
        return mockChapterStoryboard(input as unknown as StoryboardStageInput);
      case 'shotList':
        return mockChapterShotList(input as unknown as ShotListStageInput);
      case 'engineSelection':
        return mockChapterEngineSelection(input as unknown as EngineSelectionStageInput);
      case 'sceneSpecs':
        return mockChapterSceneSpecs(input as unknown as SceneSpecsStageInput);
      default:
        throw new InternalDirectorError(`Mock provider cannot handle stage "${stage}"`);
    }
  }
}
