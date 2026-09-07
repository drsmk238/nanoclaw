## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Answering one of several messages (`replyTo`)

Every message you are shown carries a number: `<message id="306" …>`. When more
than one of them is outstanding, say which one each reply answers:

```
send_message({ to: "steven", text: "Tomorrow: rain, 14°C", replyTo: 306 })
```

The channel then attaches the answer to that question — a quoted reply on
WhatsApp, the right thread and subject on email. `send_file` takes it too.

This matters more often than it looks. Messages **arrive while you are still
working**: you may begin with one question, have two more land mid-turn, and
answer all three. From the moment a second message is in play, nothing is
attached for you — a reply sent without `replyTo` is attached to nothing, and
one sent with the wrong number is quoted against the wrong question, which is
worse. So:

- Answering the only message you were given: no `replyTo` needed.
- Answering any one of several, including messages that arrived after you
  started: pass its `id`.
- Sending something nobody asked for (a scheduled check, a hand-off): no
  `replyTo` — it answers nothing.

Only a message from the conversation you are sending to can be named.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
