// Turns what is on disk for one task into one row of the pane. Only the hand-off files of
// docs/dev-workflow-herdr.md section 3.2 are read; nothing is stored, every row is derived again.

// Section 3.2's file format took effect on this day; task folders written earlier follow older
// formats and are left out rather than shown with a wrong state.
export const FORMAT_SINCE_MS = Date.parse('2026-10-03T00:00:00+08:00')

// Gate G3: a task is returned at most this many times.
export const RETURN_CAP = 3

// `git log --merges --format='%ct %s' main` → task id → merge time (ms).
// Section 3.2: a merge commit's subject starts with "Merge dev/<task id>:".
export function parseMerges(gitLog) {
  const merged = new Map()
  for (const line of gitLog.split('\n')) {
    const match = /^(\d+) Merge dev\/([^:\s]+):/.exec(line)
    if (match && !merged.has(match[2])) merged.set(match[2], Number(match[1]) * 1000)
  }
  return merged
}

// files: the task folder's entries, [{ name, mtimeMs }]. reportLastLine: last non-empty line of
// report.md, or '' when there is none. Returns null for folders without a current-format brief.md.
export function deriveTask({ id, files, reportLastLine, mergedAtMs, nowMs }) {
  const file = (name) => files.find((f) => f.name === name)
  const brief = file('brief.md')
  if (!brief || brief.mtimeMs < FORMAT_SINCE_MS) return null

  const reviews = files.filter((f) => /^review-\d+\.md$/.test(f.name))
  const rounds = reviews.length
  const lastReviewMs = Math.max(brief.mtimeMs, ...reviews.map((f) => f.mtimeMs))
  const question = file('question.md')
  const row = { id, rounds, startedMs: brief.mtimeMs }

  if (mergedAtMs !== undefined) return { ...row, state: 'merged', cycleMs: mergedAtMs - brief.mtimeMs }
  row.cycleMs = nowMs - brief.mtimeMs

  if (file('report.md')) {
    if (/^STATUS:\s*blocked\b/.test(reportLastLine)) return { ...row, state: 'blocked' }
    if (/^STATUS:\s*done\b/.test(reportLastLine)) return { ...row, state: 'review' }
    return { ...row, state: 'reporting' }
  }
  // question.md is never removed, so it only counts while it is newer than the brief and every
  // review: after that the worker has moved on.
  if (question && question.mtimeMs >= lastReviewMs) return { ...row, state: 'question' }
  return { ...row, state: rounds > 0 ? 'fixing' : 'working' }
}

export const STATE_LABELS = {
  working: '实现中',
  fixing: '修改中',
  question: '有提问',
  reporting: '写报告中',
  review: '待审查',
  blocked: '卡住',
  merged: '已合并',
}

// States that need the main session to act.
export const NEEDS_MAIN = new Set(['question', 'review', 'blocked'])

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return hours + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
  return Math.floor(hours / 24) + 'd'
}

// Active tasks first, oldest start first; merged tasks after, most recent first.
export function sortRows(rows) {
  const active = rows.filter((r) => r.state !== 'merged').sort((a, b) => a.startedMs - b.startedMs)
  const merged = rows
    .filter((r) => r.state === 'merged')
    .sort((a, b) => b.startedMs + b.cycleMs - (a.startedMs + a.cycleMs))
  return { active, merged }
}

export function summary(rows) {
  const counts = {}
  for (const r of rows) if (r.state !== 'merged') counts[r.state] = (counts[r.state] ?? 0) + 1
  return Object.entries(counts)
    .map(([state, n]) => n + ' ' + STATE_LABELS[state])
    .join(' · ')
}
