/**
 * Speech to text through Okou's existing voice endpoint.
 *
 * The Even SDK has no recogniser — it hands back raw PCM — so transcription
 * goes to `POST /api/voice-io/stt`, which already carries this user's Clerk
 * auth and audio quota. That keeps provider keys off the device entirely.
 */
import { API_BASE_URL } from '../config'
import { ApiError, type TokenProvider } from './client'

interface SttResponse {
  readonly text: string
}

export async function transcribeAudio(
  getToken: TokenProvider,
  audio: Blob,
  signal?: AbortSignal,
): Promise<string | null> {
  const token = await getToken()
  if (!token) throw new ApiError(401)

  const form = new FormData()
  form.set('file', audio, 'speech.wav')

  const response = await fetch(`${API_BASE_URL}/api/voice-io/stt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    ...(signal ? { signal } : {}),
  })

  if (!response.ok) {
    // 402 and 429 both mean the audio quota is spent; the lens shows the
    // message rather than a status code.
    if (response.status === 402 || response.status === 429) {
      throw new Error('Audio quota exceeded')
    }
    throw new ApiError(response.status)
  }

  const body = (await response.json()) as SttResponse
  const text = body.text.trim()
  return text.length > 0 ? text : null
}
