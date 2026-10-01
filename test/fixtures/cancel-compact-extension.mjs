// Cancels every compaction from session_before_compact, the way an extension can without the user
// pressing anything. Pi then ends it with the same `compaction_end.aborted` as Esc (dogfood D17).
export default function (pi) {
  pi.on("session_before_compact", () => ({ cancel: true }));
}
