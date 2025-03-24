const { spawn } = require("child_process");

class PHPWorker {
    constructor() {
        console.log("🚀 [PHPWorker] Starting PHP worker process...");
        this.phpProcess = spawn("php", ["worker.php"]);
        this.callbacks = {};

        this.phpProcess.stdout.on("data", (data) => this.onData(data));
        this.phpProcess.stderr.on("data", (data) => console.error("❌ [PHPWorker] PHP Error:", data.toString()));

        this.phpProcess.on("exit", (code, signal) => {
            console.warn(`⚠️ [PHPWorker] PHP process exited with code ${code} and signal ${signal}`);
        });

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
                console.trace("❌ [PHPWorker] ERROR parsing response: ", err, msg);
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
