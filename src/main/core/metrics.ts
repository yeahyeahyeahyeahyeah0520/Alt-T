export type MetricFlow = 'replace' | 'show' | 'paste'

export type MetricOutcome =
  | 'pasted'
  | 'clipboard-only'
  | 'cancelled'
  | 'error'
  | 'shown'
  | 'no-selection'
  | 'direct-input'

export type MetricIdeRegion = 'editor' | 'terminal' | 'unknown'

export interface MetricRunInput {
  flow: MetricFlow
  outcome: MetricOutcome
  totalMs: number
  captureMs?: number
  uiaProbeMs?: number
  translateMs?: number
  pasteVerifyMs?: number
  ideRegion?: MetricIdeRegion
  ideUnknown?: boolean
  protectedHold?: boolean
  targetChanged?: boolean
}

export interface StagePercentileStats {
  count: number
  p50Ms: number | null
  p95Ms: number | null
  p95Reliable: boolean
}

export interface MetricsSummary {
  totalRuns: number
  sampleWindowSize: number
  outcomes: Record<MetricOutcome, number>
  flags: {
    ideUnknown: number
    protectedHold: number
    targetChanged: number
  }
  ideRegions: Record<MetricIdeRegion, number>
  stages: {
    captureMs: StagePercentileStats
    uiaProbeMs: StagePercentileStats
    translateMs: StagePercentileStats
    pasteVerifyMs: StagePercentileStats
    totalMs: StagePercentileStats
  }
}

export const METRIC_FLOWS: ReadonlySet<string> = new Set<MetricFlow>(['replace', 'show', 'paste'])

export const METRIC_OUTCOMES: ReadonlySet<string> = new Set<MetricOutcome>([
  'pasted',
  'clipboard-only',
  'cancelled',
  'error',
  'shown',
  'no-selection',
  'direct-input'
])

export const METRIC_IDE_REGIONS: ReadonlySet<string> = new Set<MetricIdeRegion>([
  'editor',
  'terminal',
  'unknown'
])

const MAX_METRIC_SAMPLES = 200
const RELIABLE_P95_MIN_SAMPLES = 20

export function nowMonotonicMs(): number {
  return performance.now()
}

function sanitizeDuration(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return undefined
  }
  return Math.round(v * 1000) / 1000
}

function computeStageStats(values: ReadonlyArray<number | undefined>): StagePercentileStats {
  const sorted = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b)

  const count = sorted.length
  if (count === 0) {
    return {
      count: 0,
      p50Ms: null,
      p95Ms: null,
      p95Reliable: false
    }
  }

  const pickNearestRank = (pct: number): number => {
    const rank = Math.ceil((pct / 100) * count)
    const idx = Math.min(count - 1, Math.max(0, rank - 1))
    return sorted[idx]
  }

  return {
    count,
    p50Ms: pickNearestRank(50),
    p95Ms: pickNearestRank(95),
    p95Reliable: count >= RELIABLE_P95_MIN_SAMPLES
  }
}

export interface MetricsTracker {
  record(rawInput: MetricRunInput): void
  getSummary(): MetricsSummary
  reset(): void
}

interface StoredSample {
  totalMs: number
  captureMs?: number
  uiaProbeMs?: number
  translateMs?: number
  pasteVerifyMs?: number
}

export function createMetricsTracker(maxSamples = MAX_METRIC_SAMPLES): MetricsTracker {
  const windowLimit = Math.max(1, Math.floor(maxSamples))
  let totalRuns = 0
  let samples: StoredSample[] = []

  const emptyOutcomes = (): Record<MetricOutcome, number> => ({
    pasted: 0,
    'clipboard-only': 0,
    cancelled: 0,
    error: 0,
    shown: 0,
    'no-selection': 0,
    'direct-input': 0
  })

  const emptyRegions = (): Record<MetricIdeRegion, number> => ({
    editor: 0,
    terminal: 0,
    unknown: 0
  })

  let outcomes = emptyOutcomes()
  let ideRegions = emptyRegions()
  let flags = {
    ideUnknown: 0,
    protectedHold: 0,
    targetChanged: 0
  }

  function record(rawInput: MetricRunInput): void {
    // Allowlist-only validation so arbitrary strings or errors can never enter telemetry
    if (!rawInput || typeof rawInput !== 'object') return
    if (!METRIC_FLOWS.has(rawInput.flow) || !METRIC_OUTCOMES.has(rawInput.outcome)) {
      return
    }
    const totalMs = sanitizeDuration(rawInput.totalMs)
    if (totalMs === undefined) return

    const sample: StoredSample = { totalMs }
    const captureMs = sanitizeDuration(rawInput.captureMs)
    const uiaProbeMs = sanitizeDuration(rawInput.uiaProbeMs)
    const translateMs = sanitizeDuration(rawInput.translateMs)
    const pasteVerifyMs = sanitizeDuration(rawInput.pasteVerifyMs)
    if (captureMs !== undefined) sample.captureMs = captureMs
    if (uiaProbeMs !== undefined) sample.uiaProbeMs = uiaProbeMs
    if (translateMs !== undefined) sample.translateMs = translateMs
    if (pasteVerifyMs !== undefined) sample.pasteVerifyMs = pasteVerifyMs

    totalRuns += 1
    outcomes[rawInput.outcome] += 1

    if (rawInput.ideRegion && METRIC_IDE_REGIONS.has(rawInput.ideRegion)) {
      ideRegions[rawInput.ideRegion] += 1
    }
    if (rawInput.ideUnknown === true) {
      flags.ideUnknown += 1
    }
    if (rawInput.protectedHold === true) {
      flags.protectedHold += 1
    }
    if (rawInput.targetChanged === true) {
      flags.targetChanged += 1
    }

    samples.push(sample)
    if (samples.length > windowLimit) {
      samples = samples.slice(samples.length - windowLimit)
    }
  }

  function getSummary(): MetricsSummary {
    return {
      totalRuns,
      sampleWindowSize: samples.length,
      outcomes: { ...outcomes },
      flags: { ...flags },
      ideRegions: { ...ideRegions },
      stages: {
        captureMs: computeStageStats(samples.map((s) => s.captureMs)),
        uiaProbeMs: computeStageStats(samples.map((s) => s.uiaProbeMs)),
        translateMs: computeStageStats(samples.map((s) => s.translateMs)),
        pasteVerifyMs: computeStageStats(samples.map((s) => s.pasteVerifyMs)),
        totalMs: computeStageStats(samples.map((s) => s.totalMs))
      }
    }
  }

  function reset(): void {
    totalRuns = 0
    samples = []
    outcomes = emptyOutcomes()
    ideRegions = emptyRegions()
    flags = {
      ideUnknown: 0,
      protectedHold: 0,
      targetChanged: 0
    }
  }

  return {
    record,
    getSummary,
    reset
  }
}
