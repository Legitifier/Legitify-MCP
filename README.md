# legitify-mcp

MCP server for Legitify (LegitimizeAI.com) — Human Attestation (Approval Receipts) for AI actions.

## What this is
This server exposes MCP tools that let an agent:
- submit an attestation request
- check status
- fetch policy/templates

## Tools
- `legitify.submit_attestation_request`
- `legitify.get_attestation_status`
- `legitify.get_policy`
- `legitify.list_pending_requests`
- `legitify.get_pending_request_details`
- `legitify.review_request`

## Quickstart (local)
```bash
cd projects/legitify-mcp
npm i
npm run dev
```

### Configure in mcporter / OpenClaw
Add to your mcporter config (example):
```json
{
  "mcpServers": {
    "legitify": {
      "command": "node /ABS/PATH/legitify-mcp/src/server.js"
    }
  }
}
```

### Example calls
```bash
mcporter call --server legitify --tool "legitify.get_policy" --output json

mcporter call --server legitify --tool "legitify.submit_attestation_request" \
  --args '{"kind":"deploy","title":"Deploy v1.2.3","summary":"Ship release","risk_level":"medium","links":["https://example.com/pr/123"]}' \
  --output json

mcporter call --server legitify --tool "legitify.list_pending_requests" --args '{"limit":10}' --output json

mcporter call --server legitify --tool "legitify.review_request" \
  --args '{"attestation_request_id":"attreq_...","decision":"approved","scope":"deploy_release","notes":"staging verified","reviewed_by":"neely"}' \
  --output json

mcporter call --server legitify --tool "legitify.get_attestation_status" \
  --args '{"attestation_request_id":"attreq_..."}' \
  --output json
```

## Config
Set environment variables:
- `LEGITIFY_BASE_URL` (optional) — API base (future)
- `LEGITIFY_API_KEY` (optional)

## Notes
MVP can run without a remote API by writing requests to a local queue (JSONL) and returning `needs_info` / `pending`.
