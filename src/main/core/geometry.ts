import { clamp } from '../../shared/config'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

const POPUP_OFFSET_X = 12
const POPUP_OFFSET_Y = 16
const MIN_POPUP_HEIGHT = 200
const MAX_POPUP_HEIGHT_RATIO = 0.8

export function placePopup(anchor: Point, size: Size, workArea: Rect): Rect {
  const w = Math.max(0, Math.min(size.width, workArea.width))
  const h = Math.max(0, Math.min(size.height, workArea.height))

  let x = anchor.x + POPUP_OFFSET_X
  if (x + w > workArea.x + workArea.width) {
    x = anchor.x - POPUP_OFFSET_X - w
  }

  let y = anchor.y + POPUP_OFFSET_Y
  if (y + h > workArea.y + workArea.height) {
    y = anchor.y - POPUP_OFFSET_Y - h
  }

  x = clamp(x, workArea.x, workArea.x + workArea.width - w)
  y = clamp(y, workArea.y, workArea.y + workArea.height - h)

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h)
  }
}

export function centerOnWorkArea(size: Size, workArea: Rect): Rect {
  const w = Math.max(0, Math.min(size.width, workArea.width))
  const h = Math.max(0, Math.min(size.height, workArea.height))

  const x = workArea.x + Math.round((workArea.width - w) / 2)
  const y = workArea.y + Math.round((workArea.height - h) / 3)

  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + workArea.width - w)),
    y: Math.round(clamp(y, workArea.y, workArea.y + workArea.height - h)),
    width: Math.round(w),
    height: Math.round(h)
  }
}

export function clampToWorkArea(rect: Rect, workArea: Rect): Rect {
  const w = Math.max(0, Math.min(rect.width, workArea.width))
  const h = Math.max(0, Math.min(rect.height, workArea.height))
  const x = clamp(rect.x, workArea.x, workArea.x + workArea.width - w)
  const y = clamp(rect.y, workArea.y, workArea.y + workArea.height - h)

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h)
  }
}

export function clampPopupHeight(height: number, workAreaHeight: number): number {
  const maxHeight = Math.max(MIN_POPUP_HEIGHT, Math.round(workAreaHeight * MAX_POPUP_HEIGHT_RATIO))
  return Math.round(clamp(height, MIN_POPUP_HEIGHT, maxHeight))
}
