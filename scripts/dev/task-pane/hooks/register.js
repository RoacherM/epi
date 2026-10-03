// Task pane for MMP's self-hosting workflow: /mmp-tasks opens a pane with one row per task under
// .dev/tasks, and a line under the prompt keeps the counts. All state is derived from the
// hand-off files and git on every refresh (see derive.js).
import {
  NEEDS_MAIN,
  RETURN_CAP,
  STATE_LABELS,
  deriveTask,
  formatDuration,
  parseMerges,
  sortRows,
  summary,
} from './derive.js'

const PANE = 'mmp-tasks'
const TASKS_DIR = '.dev/tasks'
const REFRESH_MS = 5000
const MERGED_SHOWN = 5
const COLUMN_WIDTHS = [10, 10, 10, 8]

const STATE_STYLE = {
  question: { color: 'yellow', bold: true },
  review: { color: 'yellow', bold: true },
  blocked: { color: 'red', bold: true },
  error: { color: 'red', bold: true },
  merged: { dimColor: true },
}

let rows = []
let error = '' // a failure that stops the whole refresh; the last good rows stay on screen
let refreshing = false
let lastSeen = null // id → what was last announced; null until the first refresh
const reportCache = new Map() // id → { mtimeMs, lastLine }

async function lastLineOfReport($, id, mtimeMs) {
  const cached = reportCache.get(id)
  if (cached && cached.mtimeMs === mtimeMs) return cached.lastLine
  const text = await $.fs.read(TASKS_DIR + '/' + id + '/report.md')
  const lastLine = text.trim().split('\n').pop() ?? ''
  reportCache.set(id, { mtimeMs, lastLine })
  return lastLine
}

async function readTask($, id, merges, nowMs) {
  try {
    const files = await $.fs.list(TASKS_DIR + '/' + id)
    const report = files.find((f) => f.name === 'report.md')
    const reportLastLine = report ? await lastLineOfReport($, id, report.mtimeMs) : ''
    return deriveTask({ id, files, reportLastLine, mergedAtMs: merges.get(id), nowMs })
  } catch (err) {
    // One unreadable folder shows as its own row so the other tasks stay visible.
    return { id, state: 'error', reason: String(err.message ?? err), rounds: 0, startedMs: 0, cycleMs: 0 }
  }
}

async function readRows($) {
  if (!(await $.fs.exists(TASKS_DIR))) {
    throw new Error('no ' + TASKS_DIR + ' here; start Claude Code in the mmp repository root')
  }
  const log = await $.process.run(['git', 'log', '--merges', '--format=%ct %s', 'main'])
  if (log.exitCode !== 0) throw new Error('git log failed: ' + log.stderr.trim())
  const merges = parseMerges(log.stdout)
  const nowMs = await $.clock.now()
  const found = []
  for (const entry of await $.fs.list(TASKS_DIR)) {
    if (entry.kind !== 'dir') continue
    const row = await readTask($, entry.name, merges, nowMs)
    if (row) found.push(row)
  }
  return found
}

// A toast for each task that newly needs the main session. A second question in the same round
// keeps the state but is a new file, so the question's time is part of what is compared.
function announceChanges($) {
  const seen = new Map(rows.map((r) => [r.id, r.state + ':' + (r.questionMs ?? '')]))
  if (lastSeen) {
    for (const r of rows) {
      if (NEEDS_MAIN.has(r.state) && lastSeen.get(r.id) !== seen.get(r.id)) {
        $.ui.toast(r.id + ' → ' + STATE_LABELS[r.state])
      }
    }
  }
  lastSeen = seen
}

async function refresh($) {
  if (refreshing) return
  refreshing = true
  try {
    rows = await readRows($)
    error = ''
    announceChanges($)
    $.ui.status(summary(rows) || '无进行中的任务')
  } catch (err) {
    error = String(err.message ?? err)
    $.ui.status(error)
  } finally {
    refreshing = false
    $.ui.invalidate('ui.render')
  }
}

// One line of the table: cells = [[text, textProps], ...] in COLUMN_WIDTHS order.
function drawLine({ Box, Text }, key, cells) {
  return Box({
    key,
    flexDirection: 'row',
    columnGap: 2,
    children: cells.map(([text, props], i) =>
      Box({ width: COLUMN_WIDTHS[i], children: [Text({ wrap: 'truncate-end', ...props, children: [text] })] }),
    ),
  })
}

function drawRow(el, r) {
  const merged = r.state === 'merged'
  const line = drawLine(el, r.id, [
    [r.id, merged ? { dimColor: true } : { bold: true }],
    [STATE_LABELS[r.state], STATE_STYLE[r.state] ?? {}],
    [r.rounds > 0 ? '退回 ' + r.rounds + '/' + RETURN_CAP : '', r.rounds >= RETURN_CAP ? { color: 'red' } : { dimColor: true }],
    [r.state === 'error' ? '' : formatDuration(r.cycleMs), { dimColor: true }],
  ])
  if (r.state !== 'error') return line
  const { Box, Text } = el
  return Box({
    key: r.id,
    flexDirection: 'column',
    children: [line, Text({ color: 'red', wrap: 'truncate-end', children: ['  ' + r.reason] })],
  })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(REFRESH_MS, () => refresh($))
    await refresh($)
    await $.command.register({
      name: 'mmp-tasks',
      description: 'Open the MMP task pane (.dev/tasks)',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'mmp-tasks' }, async ($) => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'MMP tasks', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const { active, merged } = sortRows(rows)
    const shown = merged.slice(0, MERGED_SHOWN)
    const children = [
      ...(error ? [Text({ color: 'red', children: [error] })] : []),
      Text({ bold: true, children: [summary(rows) || '无进行中的任务'] }),
      drawLine(el, 'header', ['任务', '状态', '退回', '周期'].map((t) => [t, { dimColor: true }])),
      ...active.map((r) => drawRow(el, r)),
      ...shown.map((r) => drawRow(el, r)),
    ]
    if (merged.length > shown.length) {
      children.push(Text({ dimColor: true, children: ['更早已合并 ' + (merged.length - shown.length) + ' 个'] }))
    }
    if (rows.length === 0) children.push(Text({ dimColor: true, children: ['（没有按现行格式写的任务）'] }))
    return Box({ flexDirection: 'column', children })
  })
}
