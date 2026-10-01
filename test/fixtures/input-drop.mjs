// An extension whose `input` handler swallows any prompt that starts with "drop".
export default function (pi) {
  pi.on("input", (event) => (event.text.startsWith("drop") ? { action: "handled" } : undefined));
}
