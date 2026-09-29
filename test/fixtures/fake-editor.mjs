// Stands in for $VISUAL/$EDITOR in the Ctrl+G test: overwrites the prompt file it is given with
// fixed text and exits 0, the way a real editor would after the user saves and quits.
import { writeFileSync } from "node:fs";

const filePath = process.argv[2];
writeFileSync(filePath, "FROM-EXTERNAL-EDITOR");
