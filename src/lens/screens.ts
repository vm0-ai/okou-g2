/**
 * Lens layouts for the three screens.
 *
 * Alignment caveat: the Even SDK exposes no text alignment and no font
 * metrics, so a user message cannot be truly right-aligned. What it does
 * expose is per-container geometry, so a user row is drawn in a container
 * inset from the left and an assistant row in one flush left. The result reads
 * as two columns rather than exact alignment, and it is the closest the
 * platform allows.
 */
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

import { LENS_MESSAGE_ROWS } from '../config'
import { truncate } from './markdown'
import type { LensMessage } from './messages'

/** Logical drawing surface of one G2 lens. */
export const LENS_WIDTH = 576
export const LENS_HEIGHT = 288

export const THREADS_CONTAINER_ID = 1
export const THREADS_CONTAINER_NAME = 'okou-threads'
export const STATUS_CONTAINER_ID = 2
export const STATUS_CONTAINER_NAME = 'okou-status'
/** Message rows occupy ids 10, 11, 12… so they never collide with the above. */
const MESSAGE_CONTAINER_ID_BASE = 10

const STATUS_HEIGHT = 40
const ROW_HEIGHT = Math.floor((LENS_HEIGHT - STATUS_HEIGHT) / LENS_MESSAGE_ROWS)
/** How far a user row is pushed right; see the alignment caveat above. */
const USER_INSET = 140
/** Both columns are the same width; only their origin differs. */
const ROW_WIDTH = LENS_WIDTH - USER_INSET
const ROW_CHARS = 44

export const NEW_THREAD_ITEM = '+ New chat'

function statusContainer(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: LENS_HEIGHT - STATUS_HEIGHT,
    width: LENS_WIDTH,
    height: STATUS_HEIGHT,
    containerID: STATUS_CONTAINER_ID,
    containerName: STATUS_CONTAINER_NAME,
    zOrderIndex: 1,
    paddingLength: 4,
    content: truncate(text, ROW_CHARS + 12),
    isEventCapture: 1,
  })
}

function messageContainers(
  messages: readonly LensMessage[],
): readonly TextContainerProperty[] {
  // Newest at the bottom, so take the tail and keep reading order.
  const visible = messages.slice(-LENS_MESSAGE_ROWS)
  return visible.map((message, index) => {
    const isUser = message.role === 'user'
    return new TextContainerProperty({
      xPosition: isUser ? USER_INSET : 0,
      yPosition: index * ROW_HEIGHT,
      width: ROW_WIDTH,
      height: ROW_HEIGHT,
      containerID: MESSAGE_CONTAINER_ID_BASE + index,
      containerName: `okou-msg-${index}`,
      zOrderIndex: index + 2,
      paddingLength: 4,
      content: truncate(message.text, ROW_CHARS * 2),
      isEventCapture: 0,
    })
  })
}

/** Screen 1: the thread list, with "new chat" as the first item. */
export function threadListPage(titles: readonly string[]): RebuildPageContainer {
  const items = [NEW_THREAD_ITEM, ...titles].map((title) => truncate(title, ROW_CHARS))
  return new RebuildPageContainer({
    containerTotalNum: 1,
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: LENS_WIDTH,
        height: LENS_HEIGHT,
        containerID: THREADS_CONTAINER_ID,
        containerName: THREADS_CONTAINER_NAME,
        zOrderIndex: 1,
        paddingLength: 4,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemName: [...items],
          // Let the OS draw and track the selection; it reports the index back
          // on click, so the app does not maintain a cursor of its own.
          isItemSelectBorderEn: 1,
        }),
        isEventCapture: 1,
      }),
    ],
  })
}

/** Screen 2: messages for one thread, plus a status line. */
export function messagesPage(
  messages: readonly LensMessage[],
  status: string,
): RebuildPageContainer {
  const rows = messageContainers(messages)
  return new RebuildPageContainer({
    containerTotalNum: rows.length + 1,
    textObject: [...rows, statusContainer(status)],
  })
}

/** Screen 3: voice capture. One line is all this screen ever needs. */
export function composePage(lines: readonly string[]): RebuildPageContainer {
  const rows = lines.slice(0, LENS_MESSAGE_ROWS).map((line, index) => {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: index * ROW_HEIGHT,
      width: LENS_WIDTH,
      height: ROW_HEIGHT,
      containerID: MESSAGE_CONTAINER_ID_BASE + index,
      containerName: `okou-compose-${index}`,
      zOrderIndex: index + 2,
      paddingLength: 4,
      content: truncate(line, ROW_CHARS * 2),
      isEventCapture: 0,
    })
  })
  return new RebuildPageContainer({
    containerTotalNum: rows.length + 1,
    textObject: [...rows, statusContainer('Tap to speak · 2x-tap back')],
  })
}

/**
 * The startup page.
 *
 * `createStartUpPageContainer` must run before anything else, and the glasses
 * microphone additionally refuses to start until it has. It is a single text
 * container because at boot there is nothing to list yet.
 */
export function startupPage(text: string): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
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
        content: text,
        isEventCapture: 1,
      }),
    ],
  })
}
