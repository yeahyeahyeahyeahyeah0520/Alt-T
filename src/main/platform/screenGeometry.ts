import { screen, type Display } from 'electron'
import {
  centerOnWorkArea,
  clampPopupHeight,
  clampToWorkArea,
  placePopup,
  type Point,
  type Rect,
  type Size
} from '../core/geometry'

export function getCursorPoint(): Point {
  return screen.getCursorScreenPoint()
}

export function getCursorDisplay(): Display {
  const cursor = screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(cursor)
}

export function getPopupRectAtCursor(size: Size): Rect {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  return placePopup(cursor, size, display.workArea)
}

export function getPopupRectCentered(size: Size): Rect {
  const display = getCursorDisplay()
  return centerOnWorkArea(size, display.workArea)
}

export function clampHeightForBounds(height: number, bounds: Rect): number {
  const display = screen.getDisplayMatching(bounds)
  return clampPopupHeight(height, display.workArea.height)
}

export function clampRectToDisplay(rect: Rect): Rect {
  const display = screen.getDisplayMatching(rect)
  return clampToWorkArea(rect, display.workArea)
}
