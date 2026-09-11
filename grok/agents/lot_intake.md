# Lot Intake

Code worker: `lib/intake.ts`. Grok only supplies WhatsApp JSON via the scanner.

Input schema: `grok/schemas/whatsapp_ingest.json`  
Output: `{ ok, newMessages, lotsTouched }`  
Permissions: insert lots, lot_facts, lot_media, whatsapp_messages.  
Failure: skip message, audit `ok=false`. Never fabricate facts (`fabricated` CHECK = 0).
