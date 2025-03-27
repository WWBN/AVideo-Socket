let startTime = Date.now();
let getClientCount = () => 0;
let lastStats = { uptime: '', clients: 0, mem: '', now: '' };
const timers = {};

function setStartTime(time) {
    startTime = time;
}

function setClientCounter(fn) {
    getClientCount = fn;
}

function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}h${m}m${s}s`;
}

function updateStats() {
    const now = Date.now();
    lastStats = {
        uptime: formatUptime(now - startTime),
        clients: getClientCount(),
        mem: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
        now: new Date().toISOString().slice(11, 19) // HH:MM:SS
    };
}
setInterval(updateStats, 1000);
updateStats();

function log(...args) {
    console.log(`[🕒 ${lastStats.uptime} | 👥 ${lastStats.clients} | 💾 ${lastStats.mem} | 🗓️ ${lastStats.now}]`, ...args);
}

function logStart(label) {
    timers[label] = Date.now();
}

function logEnd(label) {
    const end = Date.now();
    const start = timers[label];
    if (!start) {
        log(`⚠️ No timer started for "${label}"`);
        return;
    }
    const duration = (end - start).toFixed(3);
    delete timers[label];
    log(`${label} took ${duration}ms`);
}

module.exports = {
    log,
    setStartTime,
    setClientCounter,
    logStart,
    logEnd
};
