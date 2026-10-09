import type { CameraMovement, CameraPreset } from '@vc/schema';

/** Maps a shot-list camera movement onto the closest renderable camera preset. */
export const CAMERA_MOVEMENT_TO_PRESET: Readonly<Record<CameraMovement, CameraPreset>> = {
  static: 'static',
  'pan-left': 'pan-left',
  'pan-right': 'pan-right',
  'tilt-up': 'tilt-up',
  'tilt-down': 'tilt-down',
  'dolly-in': 'dolly-in',
  'dolly-out': 'dolly-out',
  'truck-left': 'pan-left',
  'truck-right': 'pan-right',
  orbit: 'orbit-right',
  'crane-up': 'crane-up',
  'crane-down': 'crane-down',
  'push-in': 'push-in',
  'pull-out': 'pull-out',
  'zoom-in': 'push-in',
  'zoom-out': 'pull-out',
  handheld: 'handheld',
  tracking: 'pan-right',
};

export function cameraPresetForMovement(movement: CameraMovement): CameraPreset {
  return CAMERA_MOVEMENT_TO_PRESET[movement];
}
