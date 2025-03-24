const fs = require('fs');
const mysql = require('mysql2');
const dotenv = require('dotenv');
const dbConfig = require('./config');

// Load environment variables (optional)
dotenv.config();

console.log("🔧 MySQL Config:", dbConfig);

// Create MySQL connection
const connection = mysql.createConnection({
    host: dbConfig.mysqlHost === ('database') ? '127.0.0.1' : dbConfig.mysqlHost,
    port: dbConfig.mysqlPort,
    user: dbConfig.mysqlUser,
    password: dbConfig.mysqlPass,
    database: dbConfig.mysqlDatabase
});


// Connect to MySQL
connection.connect((err) => {
    if (err) {
        console.error("❌ Database connection failed.");
        console.error("🔍 Connection parameters:");
        console.error(`   Host    : ${dbConfig.mysqlHost}`);
        console.error(`   Port    : ${dbConfig.mysqlPort}`);
        console.error(`   User    : ${dbConfig.mysqlUser}`);
        console.error(`   Database: ${dbConfig.mysqlDatabase}`);

        console.error("\n💡 Common reasons for failure:");
        console.error(" - MySQL is not running or listening on the provided host/port");
        console.error(" - The user/password is incorrect");
        console.error(" - The database does not exist or access is denied");
        console.error(" - Firewall is blocking the connection");

        console.error("\n📄 MySQL Error:");
        console.error(err.message);

        process.exit(1);
    }

    console.log("✅ Connected to MySQL successfully.");
});

/**
 * Function to fetch and parse object_data from the plugins table
 */
function getPluginData(pluginName, callback) {
    const query = 'SELECT object_data FROM plugins WHERE name = ?';

    connection.query(query, [pluginName], (err, results) => {
        if (err) {
            console.error("❌ Query error:", err);
            callback(err, null);
            return;
        }

        if (results.length === 0) {
            console.warn("⚠️ No plugin found with that name.");
            callback(null, null);
            return;
        }

        try {
            const objectDataJson = JSON.parse(results[0].object_data);
            callback(null, objectDataJson);
        } catch (parseError) {
            console.error("❌ Error parsing JSON from plugin data:", parseError);
            callback(parseError, null);
        }
    });
}

// Export connection and function
module.exports = { connection, getPluginData };
