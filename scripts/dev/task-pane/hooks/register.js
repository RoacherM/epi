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

let rows = []
let error = ''
let refreshing = false
let lastStates = null // id → state from the previous refresh; null until the first one
const reportCache = new Map() // id → { mtimeMs, lastLine }

async function lastLineOfReport($, id, mtimeMs) {
  const cached = reportCache.get(id)
  if (cached && cached.mtimeMs === mtimeMs) return cached.lastLine
  const text = await $.fs.read(TASKS_DIR + '/' + id + '/report.md')
  const lastLine = text.trim().split('\n').pop() ?? ''
  reportCache.set(id, { mtimeMs, lastLine })
  return lastLine
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
    const id = entry.name
    const files = await $.fs.list(TASKS_DIR + '/' + id)
    const report = files.find((f) => f.name === 'report.md')
    const reportLastLine = report ? await lastLineOfReport($, id, report.mtimeMs) : ''
    const row = deriveTask({ id, files, reportLastLine, mergedAtMs: merges.get(id), nowMs })
    if (row) found.push(row)
  }
  return found
}

function announceChanges($) {
  const states = new Map(rows.map((r) => [r.id, r.state]))
  if (lastStates) {
    for (const r of rows) {
      if (NEEDS_MAIN.has(r.state) && lastStates.get(r.id) !== r.state) {
        $.ui.toast(r.id + ' → ' + STATE_LABELS[r.state])
      }
    }
  }
  lastStates = states
}

async function refresh($) {
  if (refreshing) return
  refreshing = true
  try {
    rows = await readRows($)
    error = ''
    announceChanges($)
    $.ui.status('tasks: ' + (summary(rows) || '无进行中的任务'))
  } catch (err) {
    error = String(err.message ?? err)
    $.ui.status('tasks: ' + error)
  } finally {
    refreshing = false
    $.ui.invalidate('ui.render')
  }
}

const COLUMN_WIDTHS = [10, 10, 10, 8]

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
  const urgent = NEEDS_MAIN.has(r.state)
  const merged = r.state === 'merged'
  const stateProps = r.state === 'blocked' ? { color: 'red', bold: true } : urgent ? { color: 'yellow', bold: true } : merged ? { dimColor: true } : {}
  return drawLine(el, r.id, [
    [r.id, merged ? { dimColor: true } : { bold: true }],
    [STATE_LABELS[r.state], stateProps],
    [r.rounds > 0 ? '退回 ' + r.rounds + '/' + RETURN_CAP : '', r.rounds >= RETURN_CAP ? { color: 'red' } : { dimColor: true }],
    [formatDuration(r.cycleMs), { dimColor: true }],
  ])
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
    if (error) return Text({ color: 'red', children: [error] })

    const { active, merged } = sortRows(rows)
    const shown = merged.slice(0, MERGED_SHOWN)
    const children = [
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
