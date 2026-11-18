import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { waitForClipboardChange } from '../src/main/core/clipboardPolicy'

describe('waitForClipboardChange', () => {
  it('returns new text on the 3rd read after 75ms total sleep', async () => {
    const sentinel = '\u200b__FP_SENTINEL_1__'
    let clock = 0
    let reads = 0
    const sleeps: number[] = []

    const result = await waitForClipboardChange(
      sentinel,
      {
        readText: () => {
          reads += 1
          return reads === 3 ? 'copied text' : sentinel
        },
        sleep: async (ms) => {
          sleeps.push(ms)
          clock += ms
        },
        now: () => clock
      },
      25,
      400
    )

    assert.equal(result, 'copied text')
    assert.equal(reads, 3)
    assert.equal(sleeps.length, 3)
    assert.equal(clock, 75)
  })

  it('returns null after 17 reads and 400ms when clipboard always holds sentinel', async () => {
    const sentinel = '\u200b__FP_SENTINEL_2__'
    let clock = 0
    let reads = 0
    const sleeps: number[] = []

    const result = await waitForClipboardChange(
      sentinel,
      {
        readText: () => {
          reads += 1
          return sentinel
        },
        sleep: async (ms) => {
          sleeps.push(ms)
          clock += ms
        },
        now: () => clock
      },
      25,
      400
    )

    assert.equal(result, null)
    assert.equal(reads, 17)
    assert.equal(sleeps.length, 16)
    assert.equal(clock, 400)
  })

  it('returns new text immediately on the 1st read at 25ms', async () => {
    const sentinel = '\u200b__FP_SENTINEL_3__'
    let clock = 0
    let reads = 0

    const result = await waitForClipboardChange(
      sentinel,
      {
        readText: () => {
          reads += 1
          return 'first read text'
        },
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock
      },
      25,
      400
    )

    assert.equal(result, 'first read text')
    assert.equal(reads, 1)
    assert.equal(clock, 25)
  })

  it('returns empty string rather than null when clipboard changes to empty string', async () => {
    const sentinel = '\u200b__FP_SENTINEL_4__'
    let clock = 0
    let reads = 0

    const result = await waitForClipboardChange(
      sentinel,
      {
        readText: () => {
          reads += 1
          return ''
        },
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock
      },
      25,
      400
    )

    assert.equal(result, '')
    assert.notEqual(result, null)
    assert.equal(reads, 1)
    assert.equal(clock, 25)
  })
})
