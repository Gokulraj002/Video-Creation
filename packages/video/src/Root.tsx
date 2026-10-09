import { Composition } from 'remotion';
import { defaultIntroProps, PersonalizedIntro } from './PersonalizedIntro';

export const FPS = 30;

// Add new templates here; `id` is what templates.composition_id points to.
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="PersonalizedIntro"
      component={PersonalizedIntro}
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={4 * FPS}
      defaultProps={defaultIntroProps}
      // The worker stretches the intro to fit the voice-over when one is generated
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.round((props.durationInSeconds ?? 4) * FPS),
      })}
    />
  </>
);
