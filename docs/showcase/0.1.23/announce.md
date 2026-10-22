# Epi 0.1.23 · launch copy

[← 0.1.23 showcase](README.md)

Attach `turn.mp4` (sharper on X than the GIF). Model replies in the recording are scripted (`offline-demo`); tools really ran.

---

## Single post

epi 0.1.23: diagrams in the terminal, and run times you can read at a glance.

• a ```mermaid block in a reply is drawn as box art right in the transcript: flowcharts, sequence, state, class, ER and more. Too wide? it re-lays out top-down. Can't draw it? you get the source and the reason
• tool run times stop jumping around at the end of each command. They're a tiny 4-cell bar on one aligned edge, one decade per cell, so the slow step is obvious
• the whole turn sits in one column now, even on a 300-col monitor

same agent, same context. `epi update`

github.com/RoacherM/epi

---

## Thread

**1/3** · attach `turn.mp4`

epi 0.1.23 is out. two things I kept wanting while reading my own transcripts:

diagrams the model draws should look like diagrams, and I should see which tool call was slow without reading numbers 🧵

**2/3**

mermaid: a closed ```mermaid fence becomes Unicode box art (lovely-mermaid under the hood). It waits until the fence closes so nothing jitters while streaming. If it doesn't fit it flips direction; if it can't be drawn, the label tells you why and you keep the source.

**3/3**

run times: a 4-cell log-scale bar on the turn's right edge. 10ms, 100ms, 1s, 10s per cell, the bars line up, and they grow while a tool runs. Ctrl+O shows the exact time.

and everything (tool rows, failures, your messages) now ends on the same edge as the reply text.

`epi update` · github.com/RoacherM/epi
