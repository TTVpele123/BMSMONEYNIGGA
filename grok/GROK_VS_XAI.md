# Grok Bot vs xAI API

| | Cursor Grok Bot | xAI API | Local engine |
|---|---|---|---|
| What it is | Your Cursor agent quota (resets ~Saturday) | Paid HTTP API if `XAI_API_KEY` is set | This repo |
| Use for | WhatsApp Web, forms, LinkedIn/Instagram UI | Optional extraction/copy | Orchestration, matching, safety, Gmail, DB |
| Fixes a Bot cap? | N/A | **No** | N/A |
| $20–50 Cursor upgrade | Does not reliably fix an app-side Grok limit | Irrelevant | Irrelevant |

Do not buy extra Cursor usage expecting WhatsApp scanning to unlock if the Bot cap is separate. The engine is ready either way.

If you later add `XAI_API_KEY`, wire it only into copy/classify helpers — never into `guardedOutreach`.
