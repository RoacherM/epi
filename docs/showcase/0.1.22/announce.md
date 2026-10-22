# Epi 0.1.22 · launch copy

[← 0.1.22 showcase](README.md)

Media lives next to this file (what each one shows: [README.md](README.md)). Upload the MP4s to X: they stay sharper than GIFs.
Model replies in the recordings are scripted (`offline-demo`); tools really ran.

---

## A. Main post (long form, X Premium) · attach `tour.mp4`

epi 0.1.22 is out, and it's the first version I'd call my daily driver.

epi started as "let me put a nicer face on the Pi agent SDK". Over the last few weeks it turned into the place I actually work:

• its own full-screen terminal UI, config that lives only in ~/.epi, and rules / skills / extensions you declare instead of having them picked up by accident
• isolated sub-tasks, MCP and hooks built in
• /preview to browse files, images and video without leaving the terminal
• /review: a multi-file diff of what the agent changed. Leave line comments and they go back to the agent as a draft
• /trace: a timeline of what the run actually executed and how long each step took

0.1.22 is the part you look at all day: the transcript.

I opened one of my own screenshots on a wide monitor and half the screen was `◆ Thought`, `cd /Users/me/... &&` and `exit 0`, with paragraphs stretched to 230 columns. So I spent the release teaching the TUI some book typography:

├─ each turn is one quiet spine. Tools branch off it, failures turn red, and it closes with `Worked for`
├─ tool calls take one row: line counts, `+3 −1` and the duration sit at the end. Success takes no extra row, only failures do
├─ thinking shrinks to a dim `∴ 2.1s`
├─ replies wrap at 76 columns; code and tables still get the full width
╰─ no more raw ``` fences, and 156M tokens finally reads `156M`, not `156186k`

Same agent loop underneath, and the model sees exactly the same context as before. It's just calmer to read.

`epi update`, or install: github.com/RoacherM/epi

---

## B. Thread (free accounts)

**1/5** · attach `spine.mp4`

epi 0.1.22 is out, and it's the first version I'd call my daily driver.

it's a terminal coding agent built on the Pi SDK. this release rebuilt the transcript so one agent turn reads like a page, not a log 🧵

**2/5**

the problem: my own screenshots were half `◆ Thought`, `cd /Users/me/... &&` and `exit 0`, with paragraphs 230 columns wide.

the least useful lines got the loudest spots on screen.

**3/5**

what changed:

• one spine per turn. tools branch off it, failures go red, and it closes with `Worked for`
• one row per tool call, stats and time at the end
• success is silent; only failures get a row
• thinking is a dim `∴ 2.1s`

**4/5** · attach `preview.mp4` (or `preview-markdown.png` + `review.png` + `trace.png`)

replies wrap at 76 cols and code keeps the full width.

it sits on top of what's already there:
/review: the agent's diff, with line comments sent back as a draft
/trace: what actually ran, and for how long
plus /preview, sub-tasks, MCP and hooks

**5/5**

same agent loop, same model context, much calmer screen.

`epi update`, or start at github.com/RoacherM/epi

next I'm exploring isolated workspaces and checkpoints for sub-tasks. no promises yet.

---

## C. Short single post · attach `spine.mp4`

epi 0.1.22: the first version I'd call my daily driver.

every agent turn is now one quiet spine. tool calls take one row, success is silent, thinking shrinks to `∴ 2.1s`, and replies wrap at 76 cols while code keeps the full width.

same agent, calmer screen. github.com/RoacherM/epi
