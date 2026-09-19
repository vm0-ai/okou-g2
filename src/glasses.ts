/**
 * Thin optional wrapper around the Even Hub SDK.
 *
 * The same build has to run in three places: the Even App WebView on a phone
 * paired with G2, a plain desktop browser during development, and the Even Hub
 * simulator. Everything here degrades to a no-op when no bridge is present, so
 * the auth flow stays testable without the glasses.
 */
import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

/** Logical drawing surface of one G2 lens, in container coordinates. */
const LENS_WIDTH = 576
const LENS_HEIGHT = 288

const STATUS_CONTAINER_ID = 1
const STATUS_CONTAINER_NAME = 'okou-status'

/** Text sent to the lens is trimmed to what a glance can actually absorb. */
const MAX_LINES = 4
const MAX_LINE_LENGTH = 40

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

function clampText(text: string): string {
  return text
    .split('\n')
    .slice(0, MAX_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line))
    .join('\n')
}

/**
 * Create the single status text container the auth probe draws into.
 *
 * Safe to call repeatedly: the Even App rejects a duplicate startup page, which
 * is reported as a failure rather than thrown.
 */
export async function createStatusPage(bridge: EvenAppBridge, content: string): Promise<boolean> {
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: LENS_WIDTH,
          height: LENS_HEIGHT,
          containerID: STATUS_CONTAINER_ID,
          containerName: STATUS_CONTAINER_NAME,
          zOrderIndex: 1,
          paddingLength: 4,
          borderWidth: 0,
          content: clampText(content),
          // Required to receive temple taps on this container.
          isEventCapture: 1,
        }),
      ],
    }),
  )

  return result === StartUpPageCreateResult.success
}

/** Replace the status text already shown on the lens. */
export async function updateStatusText(bridge: EvenAppBridge, content: string): Promise<boolean> {
  return bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: STATUS_CONTAINER_ID,
      containerName: STATUS_CONTAINER_NAME,
      content: clampText(content),
    }),
  )
}

/**
 * Temple / ring input on the status container.
 *
 * Double-tap must exit through `shutDownPageContainer(1)` so the system shows
 * its exit confirmation — a root page that exits silently is rejected in Even's
 * review, and without it there is no way off the app on the glasses.
 */
export function onStatusPageInput(
  bridge: EvenAppBridge,
  handlers: { onTap: () => void; onDoubleTap: () => void },
): () => void {
  return bridge.onEvenHubEvent((event: EvenHubEvent) => {
    const textEvent = event.textEvent
    if (!textEvent || textEvent.containerID !== STATUS_CONTAINER_ID) return

    switch (textEvent.eventType) {
      // The SDK normalizes a zero event type to undefined in some hosts, and
      // zero is CLICK_EVENT.
      case OsEventTypeList.CLICK_EVENT:
      case undefined:
        handlers.onTap()
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        handlers.onDoubleTap()
        break
      default:
        break
    }
  })
}

/** Exit mode 1 raises the system exit-confirmation dialog. */
export function exitApp(bridge: EvenAppBridge): Promise<boolean> {
  return bridge.shutDownPageContainer(1)
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
