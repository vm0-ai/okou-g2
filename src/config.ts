/**
 * Sync configuration and the bounds that keep a glasses client small.
 *
 * The platform SharedWorker caches chat data in IndexedDB and can afford to
 * hold a whole organization. Here the durable store is the Even App's string
 * key-value API, so every cap below is deliberate rather than incidental.
 */

/** Production Okou API. `g2.okou.ai` is already an allowed CORS origin. */
export const API_BASE_URL = 'https://api.okou.ai'

/**
 * Must match `CURRENT_CHAT_EVENT_SCHEMA_VERSION` in the API contracts. The API
 * answers 409 when it cannot serve this version and 426 when the client is too
 * old, so a mismatch fails loudly instead of corrupting the cache.
 */
export const CHAT_EVENT_SCHEMA_VERSION = 7
export const CHAT_EVENT_SCHEMA_VERSION_HEADER = 'X-Chat-Event-Schema-Version'

/** Storage layout version. Bump to invalidate every persisted namespace. */
export const STORE_VERSION = 1

/** Thread list rows kept on device, newest `sortAt` first. */
export const MAX_THREADS_PERSISTED = 100

/** Threads whose messages are synced and kept. Others stay list-only. */
export const MAX_SYNCED_THREADS = 100

/**
 * Threads synced in parallel.
 *
 * At 100 threads a serial cold start would be hundreds of sequential round
 * trips on a phone. Kept small so the Even App WebView is not saturated.
 */
export const SYNC_CONCURRENCY = 4

/** Chat event rows kept per synced thread, oldest dropped first. */
export const MAX_ROWS_PER_THREAD = 200

/**
 * Pages of 50 rows to walk when cold-starting a thread without a snapshot.
 * Bounds the fallback path so one long thread cannot stall the whole sync.
 */
export const MAX_COLD_START_PAGES = 10

/**
 * Bytes per stored value before chunking. The Even App does not document a
 * size limit for `setLocalStorage`, so values are split conservatively and
 * reassembled from a count recorded in the header.
 */
export const STORE_CHUNK_BYTES = 32 * 1024

/** Messages rendered on one lens screen. */
export const LENS_MESSAGE_ROWS = 4

/** Maximum seconds of voice captured before recording stops itself. */
export const MAX_RECORDING_SECONDS = 60

/** Glasses microphone sample rate, fixed by the Even SDK. */
export const AUDIO_SAMPLE_RATE = 16_000

/** Cursor value meaning "this thread has not been read yet". */
export const THREAD_START_SEQ_ID = 0
