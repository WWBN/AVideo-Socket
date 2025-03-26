const fs = require('fs');
const mysql = require('mysql2');
const dotenv = require('dotenv');
const dbConfig = require('./config');

// Load environment variables (optional)
dotenv.config();

console.log("🔧 MySQL Config:", dbConfig);

let connection;

/**
 * Try TCP connection first, then fallback to UNIX socket
 */
function connectToMySQL(callback) {
    // 1. Tentativa via host/porta (TCP)
    connection = mysql.createConnection({
        host: dbConfig.mysqlHost,
        port: dbConfig.mysqlPort,
        user: dbConfig.mysqlUser,
        password: dbConfig.mysqlPass,
        database: dbConfig.mysqlDatabase
    });

    connection.connect((err) => {
        if (!err) {
            console.log("✅ Connected to MySQL via TCP successfully.");
            return callback();
        }

        console.warn("⚠️ TCP connection failed. Trying UNIX socket...");
        console.warn("📄 Error:", err.message);

        // 2. Tentativa via socketPath
        connection = mysql.createConnection({
            socketPath: '/var/run/mysqld/mysqld.sock', // ajuste se necessário
            user: dbConfig.mysqlUser,
            password: dbConfig.mysqlPass,
            database: dbConfig.mysqlDatabase
        });

        connection.connect((socketErr) => {
            if (socketErr) {
                console.error("❌ Database connection failed (both TCP and socket).");
                console.error("📄 MySQL Error:", socketErr.message);
                process.exit(1);
            }

            console.log("✅ Connected to MySQL via UNIX socket successfully.");
            return callback();
        });
    });
}

/**
 * Function to fetch and parse object_data from the plugins table
 */
function getPluginData(pluginName, callback) {
    const query = 'SELECT object_data FROM plugins WHERE name = ?';
    console.log(`🧩 Executing query to fetch plugin data: "${query}" with name = "${pluginName}"`);

    connection.query(query, [pluginName], (err, results) => {
        if (err) {
            console.error("❌ Query error:", err);
            callback(err, null);
            return;
        }

        console.log(`📦 Query returned ${results.length} result(s)`);

        if (results.length === 0) {
            console.warn("⚠️ No plugin found with that name.");
            callback(null, null);
            return;
        }

        try {
            const rawData = results[0].object_data;
            console.log("📝 Raw object_data from database:", rawData);
            const objectDataJson = JSON.parse(rawData);
            console.log("✅ Successfully parsed object_data JSON");
            callback(null, objectDataJson);
        } catch (parseError) {
            console.error("❌ Error parsing JSON from plugin data:", parseError);
            callback(parseError, null);
        }
    });
}


// Export with fallback
module.exports = {
    getPluginData,
    connectToMySQL,
    get connection() {
        return connection;
    }
};
