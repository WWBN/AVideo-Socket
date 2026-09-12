// Run against the local AVideo container's network; never points at a remote host.
const https = require('node:https');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const agent = new https.Agent({ lookup: (_, options, callback) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
} });
function config(i) {
    const self = 'https://vlu.me/plugin/Chat2/?live_transmitions_history_id=50&room_users_id=1&queueProbe=' + i;
    return new Promise((resolve, reject) => {
        https.get('https://vlu.me/plugin/YPTSocket/getWebSocket.json.php?webSocketSelfURI=' + encodeURIComponent(self),
            { agent, headers: { 'User-Agent': 'Mozilla/5.0 Socket regression test' } }, response => {
                let body = ''; response.on('data', chunk => body += chunk);
                response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Configuration unavailable')); } });
            }).on('error', reject);
    });
}
async function run(i, hold = false) {
    const c = await config(i);
    // Even the configured URL must address the local test host.
    assert.equal(new URL(c.webSocketURL).hostname, 'vlu.me');
    const start = Date.now();
    const socketURL = new URL(c.webSocketURL);
    socketURL.searchParams.set('page_title', i === 0 ? '50% discount' : 'Socket regression test');
    const socket = io(socketURL.href, { agent, transports: ['websocket'], reconnection: false, timeout: 10000 });
    let handshake, ready, unexpected = 0;
    socket.on('disconnect', reason => { if (reason !== 'io client disconnect') unexpected++; });
    socket.on('yptReady', () => ready = Date.now() - start);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Immediate echo timeout')), 12000);
        socket.on('connect_error', () => { clearTimeout(timer); reject(new Error('Connect failed')); });
        socket.on('connect', () => {
            handshake = Date.now() - start;
            // This is deliberately sent before PHP authentication has completed.
            socket.emit('message', [JSON.stringify({ type: 'TESTING', msg: 'TESTING', webSocketToken: c.webSocketToken, seq: 0 })]);
        });
        socket.on('message', message => { if (message.seq === 0 && message.type === 'TESTING') { clearTimeout(timer); resolve(); } });
    });
    const immediate = Date.now() - start;
    const timings = [], pending = new Map(); const order = [];
    socket.on('message', message => {
        if (pending.has(message.seq)) {
            timings.push(Date.now() - pending.get(message.seq)); pending.delete(message.seq); order.push(message.seq);
        }
    });
    const count = hold ? 40 : 30;
    for (let seq = 1; seq <= count; seq++) {
        pending.set(seq, Date.now());
        socket.emit('message', { type: 'TESTING', webSocketToken: c.webSocketToken, seq });
        if (hold) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const deadline = Date.now() + 10000;
    while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    socket.disconnect();
    assert.equal(pending.size, 0, 'Every message must receive an echo');
    assert.deepEqual(order, Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(unexpected, 0, 'No unexpected disconnects');
    return { handshake, ready, immediate, timings, unexpected };
}
function stats(values) {
    values.sort((a, b) => a - b);
    return { min: values[0], median: values[Math.floor(values.length / 2)], p95: values[Math.floor((values.length - 1) * .95)], max: values.at(-1) };
}
(async () => {
    const concurrent = await Promise.all(Array.from({ length: 10 }, (_, i) => run(i)));
    console.log(JSON.stringify({ concurrentConnections: 10, immediateEchoes: 10, orderedBurstEchoes: 300,
        handshakeMs: stats(concurrent.map(r => r.handshake)), readyMs: stats(concurrent.map(r => r.ready)),
        immediateMs: stats(concurrent.map(r => r.immediate)), burstRoundTripMs: stats(concurrent.flatMap(r => r.timings)) }));
    const sustained = await run('sustained', true);
    console.log(JSON.stringify({ sustainedSeconds: 40, echoes: 40, roundTripMs: stats(sustained.timings), unexpectedDisconnects: sustained.unexpected }));
    agent.destroy();
})().catch(error => { console.error(error.message); agent.destroy(); process.exit(1); });
