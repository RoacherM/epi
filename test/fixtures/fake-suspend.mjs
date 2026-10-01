// Preload (`node --import`) for the Ctrl+Z test: the real suspend handler calls
// `process.kill(0, "SIGTSTP")`, which would stop the test's own process group with nothing to
// continue it. This stands in for the shell: it swallows that one call and delivers SIGCONT to the
// handler's listener 500ms later, leaving time for the test to look at the screen while "suspended".
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === 0 && signal === "SIGTSTP") {
    setTimeout(() => process.emit("SIGCONT", "SIGCONT"), 500);
    return true;
  }
  return kill(pid, signal);
};
