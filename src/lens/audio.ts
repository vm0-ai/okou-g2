/**
 * Voice capture on the glasses.
 *
 * The Even SDK does **not** provide speech recognition — `audioControl` only
 * streams raw PCM from the four-mic array (16 kHz, signed 16-bit LE, mono).
 * Transcription therefore happens server-side, through Okou's existing
 * `/api/voice-io/stt`, which already carries this user's auth and quota.
 *
 * Frames are buffered rather than streamed because that endpoint transcribes a
 * complete recording in one request.
 */
import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { AUDIO_SAMPLE_RATE, MAX_RECORDING_SECONDS } from '../config'

const BYTES_PER_SAMPLE = 2
const MAX_BYTES = AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_RECORDING_SECONDS

/** Normalize the several shapes a host may use for the PCM payload. */
function toBytes(pcm: unknown): Uint8Array | null {
  if (pcm instanceof Uint8Array) return pcm
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[])
  if (typeof pcm === 'string') {
    const binary = atob(pcm)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return null
}

/** Wrap raw PCM in a RIFF header so the endpoint sees a `audio/wav` file. */
export function pcmToWav(pcm: Uint8Array, sampleRate = AUDIO_SAMPLE_RATE): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const channels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM subchunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  return new Blob([header, pcm as BlobPart], { type: 'audio/wav' })
}

export interface Recorder {
  /** Resolves with the captured audio, or null when nothing was heard. */
  stop(): Promise<Blob | null>
  cancel(): Promise<void>
}

/**
 * Start capturing from the glasses microphone.
 *
 * `AudioInputSource.Glasses` requires the startup page to already exist, which
 * the controller guarantees before any screen is shown.
 */
export async function startRecording(
  bridge: EvenAppBridge,
  onLevel?: (seconds: number) => void,
): Promise<Recorder> {
  const chunks: Uint8Array[] = []
  let total = 0
  let stopped = false

  const unsubscribe = bridge.onEvenHubEvent((event) => {
    const audio = event.audioEvent
    if (!audio || stopped) return
    const bytes = toBytes((audio as { audioPcm?: unknown }).audioPcm)
    if (!bytes || bytes.byteLength === 0) return
    // Stop accumulating past the cap; the recorder still has to be stopped by
    // the caller, but memory stays bounded.
    if (total >= MAX_BYTES) return
    chunks.push(bytes)
    total += bytes.byteLength
    onLevel?.(total / (AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE))
  })

  const started = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!started) {
    unsubscribe()
    throw new Error('The glasses microphone did not start')
  }

  const teardown = async () => {
    stopped = true
    unsubscribe()
    await bridge.audioControl(false)
  }

  return {
    async stop() {
      await teardown()
      if (total === 0) return null
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      return pcmToWav(merged)
    },
    async cancel() {
      await teardown()
      chunks.length = 0
    },
  }
}
