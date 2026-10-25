# MCP conversation coverage and reconnect boundaries

The deployed e7029cd source already contains a real MCP adapter, not only an HTTP route or SDK. `mcpResponse` in `src/owner/worker.js` registers `conversationTools` and dispatches authenticated tool calls into `OwnerTerminal.conversation` and the durable `ConversationBridge`.

| MCP tool | Required OAuth scope |
| --- | --- |
| bridge_conversation_capabilities | pa:conversation:read |
| bridge_conversation_register_context | pa:conversation:publish |
| bridge_conversation_publish_response | pa:conversation:publish |
| bridge_conversation_response_receipt | pa:conversation:read |
| bridge_conversation_claim | pa:conversation:commands |
| bridge_conversation_acknowledge | pa:conversation:commands |

The current production `tools/list` advertises these definitions even for legacy task-only tokens. Each `tools/call` independently verifies its required scope. Registration/publishing/receipt/claim/ack also require the configured operation grant for the authenticated source; forwarding and command admission additionally require owner consent. Listing tools does not enable anything. OAuth's default remains `pa:publish pa:receipt`, intentionally not broadened.

A connector exposing only the four old task tools is **not** a complete fresh list from this implementation. Possible explanations include a cached/imported connector schema or a different server deployment/endpoint. The local tool names alone cannot establish which; missing conversation OAuth scopes explain rejected calls, but not this server omitting descriptions. Do not label an unverified cause as fact.

## Minimum controlled refresh

1. Inspect the connector's configured MCP endpoint and actual authenticated source binding. Match the existing `/mcp/<source_id>` endpoint; never infer identity from a friendly label. Do not retrieve or print tokens.
2. Use the host's supported refresh/reload-tools operation against that existing connection, then inspect `initialize` and `tools/list`. A refresh is discovery only, not OAuth expansion or permission to send a message. The specific host UI must be verified before giving click-by-click instructions.
3. If a fresh server list has the six tools but the host still exposes four, update/reimport its tool schema through the supported connector management flow. Do not silently create a new credential or broaden the connection.
4. Before calls beyond task scope, obtain explicit approval for the selected source's required conversation OAuth scopes and exact per-source operation grant. Retain task scopes only if task functionality is intended. Reauthorize through the existing consent flow with explicit requested scopes; the default authorization URL will not add conversation permissions.
5. Register only the verified real owner-bound conversation/thread, then separately enable the owner rule for that source/channel/category/context. A controlled live response and inbound instruction test needs its exact recipient/content authorization. No refresh alone authorizes these side effects.

A capable PA can actively call these MCP tools directly, without installing an HTTP SDK hook. To do so on **every** final user-visible reply, its host must actually support and configure that invocation policy. MCP availability does not globally intercept replies or wake a paused PA. Existing connector instructions restricted to task updates remain binding until explicitly changed for the selected source; do not route non-task content through `publish_task_update`.

## Evidence

`tests/conversation-mcp-transport.test.mjs` runs the production MCP SDK transport and production OAuth context validator offline. It checks actual JSON-RPC listing, all six legacy-scope denials, source identity rejection, real SQLite registration only after a separate operation grant, and initialize instructions. These tests do not assert that a particular external connector has refreshed, obtained new scopes, or sent/received a live message.
