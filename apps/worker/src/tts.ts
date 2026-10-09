import fs from 'node:fs/promises';
import { config } from '@vc/core';

export function ttsConfigured(): boolean {
  return Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_VOICE_ID);
}

/** Generates an MP3 voice-over with ElevenLabs. */
export async function synthesize(text: string, outPath: string): Promise<void> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': config.ELEVENLABS_API_KEY!,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: config.ELEVENLABS_MODEL_ID }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}
