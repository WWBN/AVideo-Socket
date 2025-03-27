const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const dbConfig = require('./config');

// Load .env variables (optional)
dotenv.config();

// Global pool reference
let pool;

/**
 * Initializes MySQL connection pool
 */
async function connectToMySQL() {
    try {
        pool = mysql.createPool({
            host: dbConfig.mysqlHost,
            port: dbConfig.mysqlPort,
            user: dbConfig.mysqlUser,
            password: dbConfig.mysqlPass,
            database: dbConfig.mysqlDatabase,
            waitForConnections: true,
            connectionLimit: 10, // Increase if needed
            queueLimit: 0
        });

        // Test connection
        const [rows] = await pool.query('SELECT 1 as test');
        console.log("✅ MySQL pool created and tested.");
    } catch (err) {
        console.error("❌ Failed to initialize MySQL pool:", err.message);
        process.exit(1);
    }
}

/**
 * Fetches plugin config from the database and parses the object_data JSON
 */
async function getPluginData(pluginName) {
    const query = 'SELECT object_data FROM plugins WHERE name = ?';
    try {
        const [results] = await pool.query(query, [pluginName]);
        console.log(`📦 Query returned ${results.length} result(s) for plugin "${pluginName}"`);

        if (!results.length) {
            console.warn("⚠️ Plugin not found.");
            return null;
        }

        const rawData = results[0].object_data;
        console.log("📝 Raw plugin data:", rawData);

        const objectDataJson = JSON.parse(rawData);
        console.log("✅ Plugin data parsed successfully.");
        return objectDataJson;
    } catch (err) {
        console.error("❌ Failed to fetch plugin data:", err);
        return null;
    }
}

module.exports = {
    connectToMySQL,
    getPluginData,
    getPool() {
        return pool;
    }
};
