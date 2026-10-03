import { expect, test } from 'claude-code/testing'
import { FORMAT_SINCE_MS, deriveTask, formatDuration, parseMerges, sortRows, summary } from '../hooks/derive.js'

const T0 = FORMAT_SINCE_MS + 3_600_000 // an hour after the format took effect
const min = (n: number) => T0 + n * 60_000
const file = (name: string, minutes: number) => ({ name, mtimeMs: min(minutes) })
const derive = (files: { name: string; mtimeMs: number }[], extra: Record<string, unknown> = {}) =>
  deriveTask({ id: 'X1', files, reportLastLine: '', mergedAtMs: undefined, nowMs: min(90), ...extra })

test('a brief alone is being worked on', () => {
  expect(derive([file('brief.md', 0)])?.state).toBe('working')
})

test('folders without a brief, or with a brief older than the format, are left out', () => {
  expect(derive([file('report.md', 5)])).toBe(null)
  expect(derive([{ name: 'brief.md', mtimeMs: FORMAT_SINCE_MS - 1 }])).toBe(null)
})

test('question.md is an open question until the main session renames it', () => {
  expect(derive([file('brief.md', 0), file('question.md', 10)])?.state).toBe('question')
  expect(derive([file('brief.md', 0), file('question-1.md', 10)])?.state).toBe('working')
  // A question asked during round 2, after the review
  const round2 = derive([file('brief.md', 0), file('report-1.md', 30), file('review-1.md', 31), file('question.md', 40)])
  expect(round2?.state).toBe('question')
  expect(round2?.questionMs).toBe(min(40))
})

test('report.md decides by its last line', () => {
  const files = [file('brief.md', 0), file('report.md', 30)]
  expect(derive(files, { reportLastLine: 'STATUS: done' })?.state).toBe('review')
  expect(derive(files, { reportLastLine: 'STATUS: blocked' })?.state).toBe('blocked')
  expect(derive(files, { reportLastLine: '## Tests' })?.state).toBe('reporting')
})

test('after a return the old report is archived and the task is being fixed', () => {
  const row = derive([file('brief.md', 0), file('report-1.md', 30), file('review-1.md', 31), file('review-2.md', 50)])
  expect(row?.state).toBe('fixing')
  expect(row?.rounds).toBe(2)
})

test('a round starts as soon as the old report is archived, before review-N.md exists', () => {
  const row = derive([file('brief.md', 0), file('report-1.md', 30)])
  expect(row?.state).toBe('fixing')
  expect(row?.rounds).toBe(1)
})

test('a report older than the latest review is stale: the task is being fixed', () => {
  const files = [file('brief.md', 0), file('report.md', 30), file('review-1.md', 31)]
  expect(derive(files, { reportLastLine: 'STATUS: done' })?.state).toBe('fixing')
})

test('a merge older than the brief belongs to an earlier task with the same id', () => {
  expect(derive([file('brief.md', 50)], { mergedAtMs: min(45) })?.state).toBe('working')
})

test('active tasks come first, oldest first; merged after, most recently merged first', () => {
  const row = (id: string, state: string, startedMs: number, cycleMs: number) => ({ id, state, startedMs, cycleMs, rounds: 0 })
  const { active, merged } = sortRows([
    row('A', 'working', 20, 1),
    row('M1', 'merged', 0, 10),
    row('B', 'review', 10, 1),
    row('M2', 'merged', 5, 30),
  ])
  expect(active.map((r) => r.id)).toEqual(['B', 'A'])
  expect(merged.map((r) => r.id)).toEqual(['M2', 'M1'])
})

test('a merged task reports brief-to-merge as its cycle', () => {
  const row = derive([file('brief.md', 0), file('report.md', 30)], { reportLastLine: 'STATUS: done', mergedAtMs: min(45) })
  expect(row?.state).toBe('merged')
  expect(row?.cycleMs).toBe(45 * 60_000)
})

test('only "Merge dev/<id>:" subjects count as merges', () => {
  const merges = parseMerges(
    ['200 Merge dev/S-D2: hunks', '150 Merge D2: old format', '120 Merge pull request #6 from x/dev-paths', '100 Merge dev/S-D2: older'].join('\n'),
  )
  expect(merges.get('S-D2')).toBe(200_000)
  expect(merges.has('D2')).toBe(false)
  expect(merges.size).toBe(1)
})

test('durations and the summary line', () => {
  expect(formatDuration(42 * 60_000)).toBe('42m')
  expect(formatDuration(125 * 60_000)).toBe('2h05m')
  expect(formatDuration(72 * 3_600_000)).toBe('3d')
  const rows = [
    { state: 'review' },
    { state: 'review' },
    { state: 'working' },
    { state: 'merged' },
  ] as Parameters<typeof summary>[0]
  expect(summary(rows)).toBe('2 待审查 · 1 实现中')
})
