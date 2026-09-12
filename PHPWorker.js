const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const dbConfig = require('./config');
const path = require('path');

class PHPWorker {
    constructor(options = {}) {
        this.scriptPath = path.resolve(`${dbConfig.systemRootPath}plugin/YPTSocket/worker.php`);
        this.requestTimeout = options.requestTimeout || 30000;
        this.maxQueueSize = options.maxQueueSize || 5000;
        this.queue = [];
        this.active = null;
        this.sequence = 0;
        this.closed = false;
        this.blocked = false;
        this.phpProcess = null;
        this.start();
    }

    start() {
        if (this.closed || this.phpProcess) return;
        this.decoder = new StringDecoder('utf8');
        this.buffer = '';
        this.blocked = false;
        const child = spawn("php", [this.scriptPath]);
        this.phpProcess = child;
        child.stdout.on('data', data => {
            if (this.phpProcess === child) this.onData(data);
        });
        child.stderr.on('data', () => {
            // PHP also writes to AVideo's log; do not copy response data/tokens here.
            console.error('[PHPWorker] PHP reported an error; check the AVideo log.');
        });
        child.stdin.on('drain', () => {
            if (this.phpProcess !== child) return;
            this.blocked = false;
            this.pump();
        });
        child.stdin.on('error', () => this.failProcess(child, 'PHP input closed'));
        child.on('error', () => this.failProcess(child, 'PHP worker could not start'));
        child.on('exit', () => this.failProcess(child, 'PHP worker exited'));
    }

    onData(data) {
        this.buffer += this.decoder.write(data);
        if (this.buffer.length > 8 * 1024 * 1024) {
            this.failProcess(this.phpProcess, 'PHP response exceeded the buffer limit');
            return;
        }
        let newline;
        while ((newline = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let response;
            try {
                response = JSON.parse(line);
            } catch (error) {
                console.error('[PHPWorker] Invalid JSON line from PHP.');
                continue;
            }
            if (!response || typeof response !== 'object' || !this.active || String(response.id) !== this.active.id) continue;
            const request = this.active;
            this.active = null;
            this.complete(request, response.response, response.error ? new Error('PHP request failed') : null);
            // Yield between requests so socket events and disconnects can run.
            setImmediate(() => this.pump());
        }
    }

    send(action, params = {}, callback) {
        if (this.closed || this.queue.length + (this.active ? 1 : 0) >= this.maxQueueSize) {
            setImmediate(() => this.complete({ callback }, null, new Error(this.closed ? 'PHP worker closed' : 'PHP queue full')));
            return;
        }
        const request = {
            id: `${Date.now()}-${++this.sequence}`,
            callback,
            deadline: Date.now() + this.requestTimeout,
        };
        try {
            request.line = JSON.stringify({ ...params, id: request.id, action }) + '\n';
        } catch (error) {
            setImmediate(() => this.complete(request, null, error));
            return;
        }
        this.queue.push(request);
        this.pump();
    }

    pump() {
        if (this.closed || this.active || this.blocked || this.restartTimer) return;
        while (this.queue.length && this.queue[0].deadline <= Date.now()) {
            this.complete(this.queue.shift(), null, new Error('PHP queue timeout'));
        }
        if (!this.queue.length) return;
        if (!this.phpProcess) this.start();
        const child = this.phpProcess;
        const request = this.queue.shift();
        this.active = request;
        request.timer = setTimeout(() => this.failProcess(child, 'PHP request timeout'), Math.max(1, request.deadline - Date.now()));
        try {
            this.blocked = !child.stdin.write(request.line);
        } catch (error) {
            this.failProcess(child, 'PHP input write failed');
        }
    }

    complete(request, response, error = null) {
        clearTimeout(request.timer);
        try {
            if (typeof request.callback === 'function') request.callback(response, error);
        } catch (callbackError) {
            console.error('[PHPWorker] Request callback failed:', callbackError.message);
        }
    }

    failProcess(child, reason) {
        if (!child || this.phpProcess !== child) return;
        this.phpProcess = null;
        this.blocked = false;
        this.buffer = '';
        // Only stop the child owned by this instance, never another server's worker.
        child.kill('SIGKILL');
        const request = this.active;
        this.active = null;
        if (!this.closed) {
            console.error('[PHPWorker]', reason);
            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                this.pump();
            }, 100);
        }
        // Never replay an in-flight API action: it may already have changed state.
        if (request) this.complete(request, null, new Error(reason));
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.restartTimer);
        this.failProcess(this.phpProcess, 'PHP worker closed');
        const pending = this.queue.splice(0);
        pending.forEach(request => this.complete(request, null, new Error('PHP worker closed')));
    }
}

module.exports = PHPWorker;
