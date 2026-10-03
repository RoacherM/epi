import { expect, mock, test } from 'claude-code/testing'
import { FORMAT_SINCE_MS } from '../hooks/derive.js'

const T0 = FORMAT_SINCE_MS + 3_600_000
const min = (n: number) => T0 + n * 60_000
const file = (name: string, minutes: number) => ({ name, kind: 'file', mtimeMs: min(minutes) })
const dir = (name: string) => ({ name, kind: 'dir', mtimeMs: 0 })

const PANE = {
  plugin: 'mmp-task-pane',
  component: 'Pane',
  requestId: 'mmp-tasks',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'MMP tasks', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// Stubs for everything the mod calls. folders: task id → its files; reads: path suffix → content.
// gitExitCode is read on every `git log`, so a test can make it fail later. Returns the toasts and status lines the mod showed.
function stubSession(on: any, folders: () => Record<string, object[]>, opts: { reads?: Record<string, string>; gitExitCode?: () => number } = {}) {
  const shown = { toasts: [] as string[], status: [] as string[] }
  on('ui.status', ($: any, e: any) => { shown.status.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { shown.toasts.push(e.text); return { value: undefined } })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', () => ({ value: { exitCode: opts.gitExitCode?.() ?? 0, stdout: '', stderr: 'fatal: not a git repository' } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', ($: any, e: any) => {
    const tree = folders()
    if (e.path.endsWith('.dev/tasks')) return { value: Object.keys(tree).map(dir) }
    const id = e.path.split('/').pop()
    return id in tree ? { value: tree[id] } : { deny: 'ENOENT ' + e.path }
  })
  on('fs.read', ($: any, e: any) => {
    const key = Object.keys(opts.reads ?? {}).find((k) => e.path.endsWith(k))
    return key === undefined ? { deny: 'EACCES ' + e.path } : { value: opts.reads![key] }
  })
  return shown
}

test('an unreadable folder is one error row; the other tasks stay visible', async ($, on) => {
  mock.clock(on, { now: min(90) })
  stubSession(on, () => ({ A1: [file('brief.md', 0)], B2: [file('brief.md', 0), file('report.md', 30)] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'A1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '读取出错' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /EACCES/ })).toBeDefined()
})

test('a failing git log shows above the table and keeps the last rows', async ($, on) => {
  const clock = mock.clock(on, { now: min(90) })
  let gitFails = false
  const shown = stubSession(on, () => ({ A1: [file('brief.md', 0)] }), { gitExitCode: () => (gitFails ? 128 : 0) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  gitFails = true
  await clock.advance(5000)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /git log failed: fatal/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A1' })).toBeDefined()
  expect(shown.status.at(-1)).toContain('git log failed')
})

test('no toast on the first refresh; a toast for each new question, even in the same round', async ($, on) => {
  const clock = mock.clock(on, { now: min(90) })
  let files = [file('brief.md', 0), file('report.md', 30)]
  const shown = stubSession(on, () => ({ A1: files }), { reads: { 'report.md': '# r\nSTATUS: done\n' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(shown.toasts).toEqual([])
  files = [file('brief.md', 0), file('report-1.md', 30), file('review-1.md', 31), file('question.md', 40)]
  await clock.advance(5000)
  files = [file('brief.md', 0), file('report-1.md', 30), file('review-1.md', 31), file('question-1.md', 40), file('question.md', 50)]
  await clock.advance(5000)
  expect(shown.toasts).toEqual(['A1 → 有提问', 'A1 → 有提问'])
})
