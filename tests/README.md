# Socket queue regression checks

## Performance improvements and local validation — version 8.0.62

- Private-message recipients are indexed by numeric user ID. All tabs remain recipients; disconnect removes only that connection and releases empty index entries. Message fields, destination rules, totals and authentication remain unchanged. URI/live fanout still sends the existing full counters for compatibility.
- Routine successful routing and presence logs use the existing `DEBUG_LOGS=1` switch. Error/warning logs and startup information remain enabled.
- Browser presence snapshots use a Set rather than repeatedly searching the roster. Legacy maps, departures, visitors and dynamically inserted user elements are covered. With 1,000 users, an isolated comparison reduced repeated linear comparisons from 500,500 to zero and selector calls from 2,000 to 1,000; this is not a DOM or production capacity benchmark.
- Page cards are rendered when the panel is open and the document visible. The latest snapshot replaces older pending ones; opening the panel or returning to the tab renders it. The compact count keeps updating. Legacy layouts without the new panel keep eager rendering.
- Counter text is written only when its displayed value changes; missing counters still reset to zero and newly inserted elements still receive current values. Drag, position cookies, viewport clamping and compact appearance are preserved.

Validation on 2026-09-12: **21 server + 11 client + 8 Chat2 JavaScript tests passed in Docker**, including indexed private delivery with 1,000 unrelated users, multiple tabs and reconnect cleanup. Chat2's temporary-table integration passed for public/private messages and rendering. The real browser presentation harness exercises both light/dark themes at desktop/mobile widths; the existing 21 drag/layout assertions also passed at both widths.

Compiled version 62: 10 concurrent clients, 300 ordered burst echoes (1–26 ms) and 40 sustained echoes over 40 seconds (0–3 ms), no unexpected disconnects. The real client recovered a failed token request, refused connection and dropped transport, with **130 ordered echoes and an empty queue**. Start the smoke test only after the server is listening; the initial attempt during startup was refused, and the ready-server run passed.

At the supplied vlu.me Chat2 URL, a message prefixed `[TESTE SOCKET 8.0.62]` arrived in a second tab without reload while the panel was collapsed. The panel displayed **8.0.62**, current counts and no browser errors. A tab opened before the server replacement reconnected automatically and displayed the new version, checking compatibility with the earlier loaded client.

The installed binary and distribution have SHA-256 `742811efe3d80f0c98bfcb3f9ca8ca1a49c6e87e9612de4e547e2ea465794953`; installed/distribution build metadata match 62. Previous runtime backup: `.compose/yptsocket-before-performance`. No commit or remote release was published.

Browser fixtures in this workspace are run with `node .compose/test-socket-presentation.cjs` and `node .compose/test-socket-info-drag.cjs`; assertions live in `plugin/YPTSocket/tests/presentation.browser.js`. These bounded checks do not establish zero regression risk or eliminate the large-room global-counter payload cost identified separately.

The PHP bridge now runs a bounded FIFO (5,000 pending requests, including the active request). Each request has a 30-second deadline including time spent waiting. Only one PHP action is written at a time, respecting stdin backpressure. A crashed or timed-out action is reported as failed and is never replayed automatically, because an API action may already have changed state. Subsequent queued work can use a replacement child process.

Connections install their message and disconnect listeners before PHP authentication. Each socket can queue up to 256 pending messages; accepted messages are processed in order after validation. Short-lived PHP senders can finish their accepted messages without appearing as online users after disconnection. Concurrent validation of the same token shares one PHP request. Token expiration remains five minutes; full cache cleanup runs at most once a minute. Totals are invalidated when connections change. Admins receive each batch once.

Chat2 registers explicit callback handlers. Events carry only IDs and conversation identifiers into a bounded browser queue. One HTTP request at a time reads up to 100 persisted messages, with a 10-second timeout and at most three attempts. Rendering, private access checks, room/history filtering and pin state come from PHP. There is a maximum of 32 pending conversation groups and 1,000 pending IDs per group, plus the active batch of up to 100 IDs. Recovery uses existing chat history reads. The `yptReady` event refreshes recent history after authentication/reconnection. It does not provide durable replay of all messages during a long outage.

## Commands

From `plugin/YPTSocket/AVideo-Socket`:

```powershell
npm test
```

From the AVideo root:

```powershell
node --test plugin/Chat2/tests/socket.test.js
node --test plugin/YPTSocket/tests/client.test.js
docker exec -w /var/www/html/AVideo avideo-avideo-1 php plugin/Chat2/tests/socket-database.php
docker exec -w /var/www/html/AVideo avideo-avideo-1 php vendor/bin/phpunit --configuration phpunit.xml
docker run --rm --network container:avideo-avideo-1 -v D:/git/htdocs/AVideo:/workspace:ro node:20-alpine node /workspace/plugin/YPTSocket/AVideo-Socket/tests/docker-smoke.js
docker run --rm --network container:avideo-avideo-1 -v D:/git/htdocs/AVideo:/workspace:ro node:20-alpine node /workspace/plugin/YPTSocket/tests/docker-client.js
```

Wait until the socket server reports `Listening on` before running the smoke test. The smoke test forces all requests to loopback in the app container's network and keeps credentials out of its output. The database integration test uses a connection-local temporary table and does not change chat history.

## Local validation, 2026-09-11

- 22 JavaScript regression tests passed: FIFO, unique IDs, split UTF-8 responses, backpressure, deadlines, worker restart, overload, early messages, disconnected senders, token coalescing/expiry, totals, admin broadcasts, browser batching/retry, canonical rendering and conversation isolation.
- PHP suite: 512 tests, 4,342 assertions, no failures; one Windows-only test skipped in Linux.
- PHP database integration passed for public/private access, room/history filtering, pins, links, attachments, polls, and persisted donation badges. HTTP guest access to private messages returned 403; malformed IDs returned an error.
- Compiled Linux version `8.0.58`: 10 concurrent connections, 10 immediate authentication-race echoes and 300 ordered burst echoes passed. Handshakes: 42–68 ms; immediate echoes including authentication: 43–87 ms; burst round trips: 3–32 ms. These are local protocol measurements, not browser page-load times or a production capacity estimate.
- Sustained check on the compiled version: 40 echoes over 40 seconds, 0–4 ms round trips, no unexpected disconnects.
- Browser at the user-provided Chat2 URL: live message/link delivery, pin, unpin and deletion synchronized between two tabs without reload. A message sent before the receiver connected demonstrated the initial-history gap addressed by `yptReady` reconciliation.
- Temporary database fixtures were removed automatically. Browser test messages are visibly prefixed `[TESTE SOCKET]`; message B3 was deleted to validate deletion, and the test pin was removed.

This initial version was subsequently replaced by the functional fixes below. The original local binary remains backed up at `.compose/yptsocket-before-queue`.

These checks do not establish zero regression risk. Large production loads, long outages, cross-browser embedding and actual payment/donation execution still require their respective environment tests. Super Chat presentation is retrieved from server-written cache for ten minutes, falling back to persisted badge content; no payment is initiated by these tests.

## Functional fixes and local validation — version 8.0.61

- Resource routing preserves the requested recipient before adding sender metadata. Numeric user IDs and their string representations match consistently; invalid IDs and the existing no-recipient sentinel do not become broadcasts.
- Page titles with literal percent signs or malformed escapes do not throw out of the connection handler. The Docker smoke test includes such a title.
- Presence changes invalidate totals and roster together. The next five-second broadcast publishes a consistent snapshot even when the message batch is empty, including the last user's departure. Idle snapshots are not repeatedly recomputed.
- The browser uses one reconnect loop with a fresh-token request, a ten-second HTTP timeout, backoff from two to sixty seconds and guards against stale transport events. Connected means authentication completed (`yptReady`, or the first server message for older implementations), not merely that the transport opened. The client's own resource ID is retained across broadcast batches.
- Offline browser sends use a FIFO of at most 1,000 messages, with a thirty-second lifetime and one timer. Payloads are captured at enqueue time and use the current token at send time. Up to 32 messages are sent per turn, with a 25 ms interval between chunks. Overflow, expiry, invalid payload and send errors report `YPTSocketSendError`; a send with an uncertain result is not replayed.
- The legacy WebSocket variable mismatch is fixed; the existing TESTING echo confirms readiness even without presence broadcasts. Array and legacy-map online rosters update the correct user labels and clear departures.
- The panel describes its count as users/visitors by device, keeps the compact count and preserves drag, saved position, viewport bounds and quiet appearance. The installer does not replace a newer local build with an older published version.

Validation: **19 server tests + 11 browser-client tests + 8 Chat2 tests passed**. PHP: **512 tests / 4,342 assertions**, one platform-specific skip. Chat2 database integration and the panel's desktop/mobile-width harness passed. Browser Chat2 delivery between two tabs succeeded without reloading, and the receiver's error/warning log was empty.

The production browser client code was also exercised against the local Docker socket: an injected failed HTTP token request, a real refused connection and a forced transport close all recovered; **130 echoes arrived once, in order**, across two authenticated connections, with an empty queue afterward. The compiled server handled ten concurrent clients, 300 ordered burst echoes and 40 sustained echoes without unexpected disconnection. A separate two-client check confirmed the corrected resource destination in the running **8.0.61** binary.

The running binary, `dist/build-info.json` and installed `nodeSocket/build-info.json` all match version 61. Binary SHA-256: `7d0f42c677fe547b2f2645a9e52a9a262f1f69e1cd7c85e90780eff92aab55fc`. The previous runtime is backed up at `.compose/yptsocket-before-review`. No commit or remote release was published. One browser message is visibly prefixed `[TESTE SOCKET 8.0.61]`.
