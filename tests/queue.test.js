const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(file, replacements, extra = {}) {
    const context = { module: { exports: {} }, require: name => replacements[name] || require(name),
        console: { log() {}, error() {} }, URLSearchParams, process, Buffer, setTimeout, clearTimeout, setImmediate, setInterval, ...extra };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    return context.module.exports;
}
function worker(options = {}, backpressure = false) {
    const children = [];
    const Worker = load('PHPWorker.js', {
        './config': { systemRootPath: '/test/' },
        child_process: { spawn() {
            const child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
            child.lines = []; child.stdin.write = line => { child.lines.push(JSON.parse(line)); return !backpressure; };
            child.kill = () => { child.killed = true; };
            children.push(child); return child;
        } }
    });
    const instance = new Worker(options);
    const reply = (child, value) => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: child.lines.at(-1).id, response: value }) + '\n'));
    return { instance, children, reply };
}
test('same-millisecond requests have unique IDs and FIFO callbacks', async () => {
    const { instance: w, children, reply } = worker();
    const results = [];
    for (let i = 0; i < 100; i++) w.send('read', {}, value => results.push(value));
    assert.equal(children[0].lines.length, 1);
    for (let i = 0; i < 100; i++) { reply(children[0], i); await tick(); }
    assert.equal(new Set(children[0].lines.map(line => line.id)).size, 100);
    assert.deepEqual(results, Array.from({ length: 100 }, (_, i) => i)); w.close();
});
test('fragmented UTF-8 and multiple lines do not lose responses', () => {
    const { instance: w, children } = worker(); let result;
    w.send('read', {}, value => { result = value; });
    const data = Buffer.from('notice\nnull\n' + JSON.stringify({ id: children[0].lines[0].id, response: 'olá 🌍' }) + '\n');
    for (const byte of data) children[0].stdout.emit('data', Buffer.from([byte]));
    assert.equal(result, 'olá 🌍'); w.close();
});
test('stdin backpressure waits for drain', async () => {
    const { instance: w, children, reply } = worker({}, true);
    w.send('a'); w.send('b'); reply(children[0], 1); await tick();
    assert.equal(children[0].lines.length, 1);
    children[0].stdin.emit('drain'); assert.equal(children[0].lines.length, 2); w.close();
});
test('bounded queue reports overflow, and close completes pending requests once', async () => {
    const { instance: w } = worker({ maxQueueSize: 2 }); const errors = [];
    for (let i = 0; i < 3; i++) w.send('read', {}, (_, error) => errors.push(error.message));
    await tick(); assert.deepEqual(errors, ['PHP queue full']); w.close(); w.close();
    assert.equal(errors.length, 3);
});
test('worker crash fails in-flight action without replay and resumes queued work', async () => {
    const { instance: w, children, reply } = worker(); let failures = 0; let value;
    w.send('API', {}, (_, error) => { if (error) failures++; });
    w.send('read', {}, response => { value = response; });
    children[0].emit('exit', 1);
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(children.length, 2); assert.equal(children[1].lines[0].action, 'read');
    reply(children[1], 42); assert.equal(value, 42); assert.equal(failures, 1); w.close();
});
test('timeout fails stuck and expired requests without hanging callbacks', async () => {
    const { instance: w } = worker({ requestTimeout: 20 }); let completed = 0;
    w.send('API', {}, (_, error) => { assert.ok(error); completed++; });
    w.send('read', {}, (_, error) => { assert.ok(error); completed++; });
    await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(completed, 2); w.close();
});

function handler() {
    const auth = [];
    const intervals = [];
    const log = new Proxy({}, { get: () => () => {} });
    const Handler = load('MessageHandler.js', { './PHPWorker': class {}, './logger': log,
        './SocketMessageType': require('../SocketMessageType') }, { setInterval: fn => intervals.push(fn) });
    const h = new Handler({}, { serverVersion: 'test' }, 'test', { send: (action, params, cb) => auth.push(cb) });
    const listeners = {}; const emitted = [];
    const s = { id: 's1', handshake: { query: { webSocketToken: 'token' } },
        on: (event, fn) => { listeners[event] = fn; }, emit: (...args) => emitted.push(args),
        join() {}, disconnect: () => listeners.disconnect('test') };
    return { h, s, listeners, emitted, auth, intervals };
}
test('early messages wait for authentication and retain order', async () => {
    const { h, s, listeners, auth } = handler(); const seen = [];
    h.processIncomingMessage = (_, message) => seen.push(message.n);
    h.onConnection(s);
    for (let n = 0; n < 10; n++) listeners.message([JSON.stringify({ webSocketToken: 'token', n })]);
    assert.equal(seen.length, 0); assert.equal(auth.length, 1);
    auth[0]({ from_users_id: 1 });
    for (let i = 0; i < 12; i++) await tick();
    assert.deepEqual(seen, Array.from({ length: 10 }, (_, i) => i));
});
test('short-lived PHP sender delivers accepted messages without becoming a ghost client', async () => {
    const { h, s, listeners, auth } = handler(); let delivered = 0;
    h.processIncomingMessage = () => delivered++; h.onConnection(s);
    listeners.message({ webSocketToken: 'token' }); listeners.disconnect('transport close');
    auth[0]({ from_users_id: 1 }); await tick();
    assert.equal(delivered, 1); assert.equal(h.clients.size, 0); assert.equal(h.getTotals().total_users_online, 0);
});
test('invalid authentication never routes queued messages or joins online clients', () => {
    const { h, s, listeners, auth } = handler(); let delivered = 0;
    h.processIncomingMessage = () => delivered++; h.onConnection(s);
    listeners.message({ webSocketToken: 'token' }); auth[0](null, new Error('timeout'));
    assert.equal(delivered, 0); assert.equal(h.clients.size, 0); assert.equal(s.yptQueue.length, 0);
});
test('concurrent token lookups share one PHP request', () => {
    const { h, auth } = handler(); let callbacks = 0;
    for (let i = 0; i < 50; i++) h.getDecryptedInfo('same', () => callbacks++);
    assert.equal(auth.length, 1); auth[0]({ from_users_id: 1 }); assert.equal(callbacks, 50);
});
test('cache hits avoid full scans and expired tokens are still rejected immediately', () => {
    const { h } = handler();
    for (let i = 0; i < 10000; i++) h.decryptedInfoCache.set(String(i), { data: {}, createdAt: Date.now() });
    h.cleanupOldCache(); let scans = 0;
    const iterate = h.decryptedInfoCache[Symbol.iterator].bind(h.decryptedInfoCache);
    h.decryptedInfoCache[Symbol.iterator] = () => { scans++; return iterate(); };
    for (let i = 0; i < 1000; i++) assert.ok(h.getCachedDecryptedInfo('1'));
    assert.equal(scans, 0);
    h.decryptedInfoCache.set('expired', { data: {}, createdAt: Date.now() - 300001 });
    assert.equal(h.getCachedDecryptedInfo('expired'), null);
});
test('totals cache invalidates on connect and disconnect', () => {
    const { h, s, auth, listeners } = handler(); const before = h.getTotals();
    h.onConnection(s); auth[0]({ from_users_id: 1 });
    assert.equal(h.getTotals().total_users_online, 1); assert.notEqual(h.getTotals(), before);
    assert.equal(h.getTotals(), h.getTotals()); listeners.disconnect('test');
    assert.equal(h.getTotals().total_users_online, 0);
});
test('broadcast reaches admins once and keeps their metadata out of the public room', () => {
    const { h, intervals } = handler(); const deliveries = [];
    h.io = { to: room => {
        const delivery = { room };
        const target = { except: excluded => { delivery.excluded = excluded; return target; },
            emit: (_, message) => deliveries.push({ ...delivery, message }) };
        return target;
    } };
    h.startPeriodicBroadcast(); h.msgToAllQueue.push({ msg: 'test' }); intervals[0]();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].room, 'globalRoom'); assert.equal(deliveries[0].excluded, 'adminsRoom');
    assert.equal('users_uri' in deliveries[0].message, false);
    assert.equal(deliveries[1].room, 'adminsRoom'); assert.ok(deliveries[1].message.users_uri);
});
test('sending to multiple tabs computes totals only once', () => {
    const { h } = handler(); let totals = 0; let sent = 0;
    h.getTotals = () => { totals++; return {}; };
    for (let i = 0; i < 10; i++) h.clients.set(String(i), { users_id: 1, id: String(i), socket: { emit: () => sent++ } });
    h.msgToUsers_id({}, 1); assert.equal(sent, 10); assert.equal(totals, 1);
});

test('resource routing preserves the requested recipient and sender metadata', () => {
    const { h, s } = handler(); const received = [];
    s.clientInfo = { id: s.id, users_id: 1 };
    for (const id of [s.id, 'recipient']) h.clients.set(id, { id, socket: { emit: (_, msg) => received.push({ id, msg }) } });
    h.processIncomingMessage(s, { resourceId: 'recipient', msg: 'hello' });
    assert.equal(received.length, 1); assert.equal(received[0].id, 'recipient');
    assert.equal(received[0].msg.resourceId, s.id);
});

test('destination-free broadcast and live redirect are not replaced by sender resourceId', () => {
    const { h, s } = handler(); s.clientInfo = { id: s.id, users_id: 1 };
    let redirect; h.msgToAllSameLive = (...args) => redirect = args;
    h.processIncomingMessage(s, { msg: 'broadcast' }); assert.equal(h.msgToAllQueue.length, 1);
    h.processIncomingMessage(s, { json: { redirectLive: { live_key: 'live', live_servers_id: 2 } } });
    assert.equal(redirect[0], 'live'); assert.equal(redirect[1], 2);
});

test('numeric and string user IDs deliver equally without changing special destinations', () => {
    const { h } = handler(); const received = [];
    h.clients.set('r', { users_id: 7, id: 'r', socket: { emit: () => received.push('r') } });
    for (const id of [7, '7', '007']) h.msgToUsers_id({}, id);
    for (const id of [-1, '-1', false, null, '', '7invalid', 7.5]) h.msgToUsers_id({}, id);
    assert.equal(received.length, 3);
});

test('literal percent signs and malformed escapes cannot crash connection setup', () => {
    for (const title of ['50% discount', '%E0%A4%A', '100%25%20ready']) {
        const { h, s, auth } = handler(); s.handshake.query.page_title = title;
        assert.doesNotThrow(() => h.onConnection(s)); auth[0]({ from_users_id: 7 });
        assert.ok(h.clients.get(s.id).page_title);
    }
});

test('presence snapshots agree with totals and publish departures without another message', () => {
    const { h, s, auth, listeners, intervals, emitted } = handler(); const messages = [];
    h.io = { to: () => ({ except() { return this; }, emit: (_, msg) => messages.push(msg) }) };
    h.startPeriodicBroadcast(); h.onConnection(s); auth[0]({ from_users_id: 7, ip: '127.0.0.1', yptDeviceId: 'device' });
    assert.equal(emitted.find(event => event[0] === 'yptReady')[1].resourceId, s.id);
    intervals[0]();
    assert.equal(messages[0].autoUpdateOnHTML.total_devices_online, 1);
    assert.equal(messages[0].users_id_online[0].users_id, 7);
    assert.equal(messages[0].messages.length, 0);
    listeners.disconnect('test'); intervals[0]();
    assert.equal(messages[2].users_id_online.length, 0);
    assert.equal(messages[2].autoUpdateOnHTML.total_users_online, 0);
    intervals[0](); assert.equal(messages.length, 4, 'idle server avoids repeated snapshots');
});
