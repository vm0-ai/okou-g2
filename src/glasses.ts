/**
 * Bridge discovery and device status.
 *
 * The same build has to run in three places: the Even App WebView on a phone
 * paired with G2, a plain desktop browser during development, and the Even Hub
 * simulator. This module answers "is there a host at all" so everything above
 * it can degrade cleanly. Screen rendering and input live in `src/lens/`.
 */
import {
  DeviceConnectType,
  waitForEvenAppBridge,
  type DeviceStatus,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

/**
 * `detecting` is a real state, not a placeholder: the Even App injects its host
 * handler some time after the page loads, so an early read cannot tell "no
 * glasses" apart from "not injected yet".
 */
export type BridgePhase = 'detecting' | 'unavailable' | 'ready'

export interface GlassesState {
  phase: BridgePhase
  /** Whether the startup page container has been created. */
  pageReady: boolean
  connectType: DeviceConnectType
  batteryLevel?: number
  isWearing?: boolean
  error?: string
}

export const initialGlassesState: GlassesState = {
  phase: 'detecting',
  pageReady: false,
  connectType: DeviceConnectType.None,
}

let bridgePromise: Promise<EvenAppBridge | null> | undefined

/**
 * Whether an Even App host is actually listening.
 *
 * The SDK installs its bridge singleton and reports `ready` in any browser, so
 * `waitForEvenAppBridge()` resolves on a plain desktop page too. The host
 * handler the bridge posts through is the only reliable signal, and the Even
 * App injects it asynchronously, so this is polled rather than read once.
 */
function hasEvenAppHost(): boolean {
  const host = (window as { flutter_inappwebview?: { callHandler?: unknown } })
    .flutter_inappwebview
  return typeof host?.callHandler === 'function'
}

async function waitForEvenAppHost(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasEvenAppHost()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return hasEvenAppHost()
}

/**
 * Resolve the bridge, or null when this page is not hosted by the Even App.
 */
export function connectBridge(timeoutMs = 15000): Promise<EvenAppBridge | null> {
  if (!bridgePromise) {
    bridgePromise = (async () => {
      if (typeof window === 'undefined') return null
      try {
        if (!(await waitForEvenAppHost(timeoutMs))) return null
        return await waitForEvenAppBridge()
      } catch {
        return null
      }
    })()
  }
  return bridgePromise
}


export function onDeviceStatus(
  bridge: EvenAppBridge,
  callback: (status: DeviceStatus) => void,
): () => void {
  return bridge.onDeviceStatusChanged(callback)
}

export function describeConnection(state: GlassesState): string {
  if (state.phase === 'detecting') return 'Looking for Even App…'
  if (state.phase === 'unavailable') return 'Not running inside Even App'
  switch (state.connectType) {
    case DeviceConnectType.Connected:
      return state.batteryLevel === undefined
        ? 'G2 connected'
        : `G2 connected · ${state.batteryLevel}%`
    case DeviceConnectType.Connecting:
      return 'Connecting to G2…'
    case DeviceConnectType.Disconnected:
      return 'G2 disconnected'
    case DeviceConnectType.ConnectionFailed:
      return 'G2 connection failed'
    default:
      return 'Waiting for G2'
  }
}
