import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  centerOnWorkArea,
  clampPopupHeight,
  clampToWorkArea,
  placePopup
} from '../src/main/core/geometry'

describe('geometry.placePopup', () => {
  const mainWorkArea = { x: 0, y: 0, width: 1920, height: 1040 }
  const popupSize = { width: 460, height: 340 }

  it('places popup normally below-right of cursor', () => {
    assert.deepEqual(placePopup({ x: 100, y: 100 }, popupSize, mainWorkArea), {
      x: 112,
      y: 116,
      width: 460,
      height: 340
    })
  })

  it('flips horizontally when overflowing right edge', () => {
    assert.deepEqual(placePopup({ x: 1900, y: 100 }, popupSize, mainWorkArea), {
      x: 1428,
      y: 116,
      width: 460,
      height: 340
    })
  })

  it('flips vertically when overflowing bottom edge', () => {
    assert.deepEqual(placePopup({ x: 100, y: 1000 }, popupSize, mainWorkArea), {
      x: 112,
      y: 644,
      width: 460,
      height: 340
    })
  })

  it('flips both axes at bottom-right corner', () => {
    assert.deepEqual(placePopup({ x: 1919, y: 1039 }, popupSize, mainWorkArea), {
      x: 1447,
      y: 683,
      width: 460,
      height: 340
    })
  })

  it('supports secondary display with negative coordinates', () => {
    const secondaryWorkArea = { x: -1920, y: 0, width: 1920, height: 1040 }
    assert.deepEqual(placePopup({ x: -1800, y: 50 }, popupSize, secondaryWorkArea), {
      x: -1788,
      y: 66,
      width: 460,
      height: 340
    })
  })

  it('shrinks and clamps when popup is larger than workArea', () => {
    assert.deepEqual(
      placePopup({ x: 10, y: 10 }, popupSize, { x: 0, y: 0, width: 300, height: 200 }),
      {
        x: 0,
        y: 0,
        width: 300,
        height: 200
      }
    )
  })

  it('rounds fractional coordinates', () => {
    assert.deepEqual(placePopup({ x: 100.4, y: 100.6 }, popupSize, mainWorkArea), {
      x: 112,
      y: 117,
      width: 460,
      height: 340
    })
  })
})

describe('geometry.centerOnWorkArea and clamping', () => {
  it('centers horizontally and places at upper third vertically on primary display', () => {
    assert.deepEqual(
      centerOnWorkArea({ width: 460, height: 340 }, { x: 0, y: 0, width: 1920, height: 1040 }),
      {
        x: 730,
        y: 233,
        width: 460,
        height: 340
      }
    )
  })

  it('centers properly on secondary display with negative coordinates', () => {
    assert.deepEqual(
      centerOnWorkArea(
        { width: 460, height: 340 },
        { x: -1920, y: 100, width: 1920, height: 1040 }
      ),
      {
        x: -1190,
        y: 333,
        width: 460,
        height: 340
      }
    )
  })

  it('clamps popup height to [200, 0.8 * workAreaHeight] and clamps rect inside workArea', () => {
    assert.equal(clampPopupHeight(100, 1000), 200)
    assert.equal(clampPopupHeight(500, 1000), 500)
    assert.equal(clampPopupHeight(950, 1000), 800)

    assert.deepEqual(
      clampToWorkArea({ x: 1600, y: 900, width: 460, height: 340 }, { x: 0, y: 0, width: 1920, height: 1040 }),
      { x: 1460, y: 700, width: 460, height: 340 }
    )
  })
})
