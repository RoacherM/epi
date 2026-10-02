/** A queued AgentMessage's own text content joined into one string -- matches exactly what
 * AgentSession._queueSteer/_queueFollowUp push onto the plain-text `_steeringMessages`/
 * `_followUpMessages` arrays, since both are built from the same `text` variable in the same call
 * (agent-session.js). Used to pair a peeked AgentMessage back to its text entry by content, not
 * position (item 3): `session.sendCustomMessage` (agent-session.js ~1496) enqueues an extension's
 * custom message straight into the Agent's own queue with no corresponding text-array entry at
 * all, so a positional pairing could silently attach *its* images to the wrong queued text. */
function queuedMessageText(message) {
    const content = message !== null && typeof message === "object" && "content" in message ? message.content : undefined;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}
function queuedMessageImages(message) {
    const content = message !== null && typeof message === "object" && "content" in message ? message.content : undefined;
    return Array.isArray(content) ? content.filter((part) => part.type === "image") : [];
}
/** Pairs each of `texts` with the first not-yet-claimed `peeked` message whose own text content
 * equals it (see queuedMessageText), consuming that message so two identical queued texts don't
 * both draw images from the same one. */
export function imagesFor(texts, peeked) {
    const available = [...peeked];
    return texts.map((text) => {
        const index = available.findIndex((message) => queuedMessageText(message) === text);
        if (index === -1)
            return [];
        const [message] = available.splice(index, 1);
        return queuedMessageImages(message);
    });
}
//# sourceMappingURL=queued-messages.js.map