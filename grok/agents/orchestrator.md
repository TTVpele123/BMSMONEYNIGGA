# Orchestrator (code, not Grok)

Deterministic. Owns event queue, retries (max 5 then dead-letter), kill switch, and worker dispatch.

Inputs: `events` rows. Outputs: worker calls + audit_log. Permissions: all internal tables. Failure: markFailed, never mark success.
