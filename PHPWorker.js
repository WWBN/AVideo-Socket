const { spawn } = require("child_process");
const dbConfig = require('./config');

class PHPWorker {
    constructor() {
        const scriptPath = path.resolve(`${dbConfig.systemRootPath}plugin/YPTSocket/worker.php`);

        console.log("🧹 [PHPWorker] Killing existing PHP worker processes...");
        try {
            // Kill all running processes that are executing the same PHP script (excluding the grep process itself)
            const command = `ps aux | grep '${scriptPath}' | grep -v grep | awk '{print $2}' | xargs -r kill -9`;
            execSync(command);
            console.log("✅ [PHPWorker] Previous PHP worker processes terminated.");
        } catch (error) {
            console.warn("⚠️ [PHPWorker] Error killing previous processes:", error.message);
        }

        console.log("🚀 [PHPWorker] Starting PHP worker process...");
        this.phpProcess = spawn("php", [scriptPath]);
        this.callbacks = {};

        // Listen to PHP stdout for responses
        this.phpProcess.stdout.on("data", (data) => this.onData(data));

        // Handle PHP error output
        this.phpProcess.stderr.on("data", (data) => console.error("❌ [PHPWorker] PHP Error:", data.toString()));

        // Handle PHP process exit
        this.phpProcess.on("exit", (code, signal) => {
            console.warn(`⚠️ [PHPWorker] PHP process exited with code ${code} and signal ${signal}`);
        });

        // Handle errors while starting PHP process
        this.phpProcess.on("error", (err) => {
            console.error(`🚨 [PHPWorker] Error starting PHP process: ${err.message}`);
        });
    }

    /**
     * Handles incoming data from PHP stdout
     */
    onData(data) {
        const messages = data.toString().split("\n").filter(Boolean);
        for (const msg of messages) {
            try {
                const json = JSON.parse(msg);

                //console.log(`📩 [PHPWorker] Received response:`, json);

                // Find callback by ID
                if (json.id && this.callbacks[json.id]) {
                    const callback = this.callbacks[json.id];
                    delete this.callbacks[json.id]; // Remove the callback after execution
                    callback(json.response);
                } else {
                    console.warn(`⚠️ [PHPWorker] No matching callback for response ID: ${json.id}`);
                }
            } catch (err) {
                console.error("❌ [PHPWorker] ERROR parsing response: ", err, msg);
            }
        }
    }

    /**
     * Sends a request to PHP and waits for a response
     */
    send(action, params = {}, callback) {
        const id = Date.now().toString();
        this.callbacks[id] = callback;

        const requestData = JSON.stringify({ id, action, ...params }) + "\n";

        //console.log(`🚀 [PHPWorker] Sending request to PHP:`, requestData);

        try {
            this.phpProcess.stdin.write(requestData);
            //console.log(`✅ [PHPWorker] Request successfully written to PHP stdin (id=${id})`);
        } catch (error) {
            console.error(`❌ [PHPWorker] Failed to send request to PHP: ${error.message}`);
        }
    }

    close() {
        console.log("🔌 [PHPWorker] Closing PHP worker process...");
        try {
            this.phpProcess.stdin.write("exit\n");
            this.phpProcess.kill();
            console.log("✅ [PHPWorker] Successfully closed PHP worker process.");
        } catch (error) {
            console.error(`❌ [PHPWorker] Error closing PHP worker: ${error.message}`);
        }
    }
}

module.exports = PHPWorker;
