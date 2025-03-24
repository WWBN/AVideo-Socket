const fs = require('fs');
const mysql = require('mysql2');
const dotenv = require('dotenv');

// Load environment variables (optional)
dotenv.config();

// Function to parse PHP config file and extract MySQL credentials
function parsePHPConfig(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const mysqlHost = content.match(/\$mysqlHost\s*=\s*'([^']+)'/)[1];
        const mysqlPort = content.match(/\$mysqlPort\s*=\s*'([^']+)'/)[1];
        const mysqlUser = content.match(/\$mysqlUser\s*=\s*'([^']+)'/)[1];
        const mysqlPass = content.match(/\$mysqlPass\s*=\s*'([^']+)'/)[1];
        const mysqlDatabase = content.match(/\$mysqlDatabase\s*=\s*'([^']+)'/)[1];

        return { mysqlHost, mysqlPort, mysqlUser, mysqlPass, mysqlDatabase };
    } catch (error) {
        console.error('Error reading PHP config:', error);
        return null;
    }
}

const dbConfig = parsePHPConfig('../../../videos/configuration.php');

if (!dbConfig) {
    console.error("Failed to load database configuration.");
    process.exit(1);
}

// Create MySQL connection
const connection = mysql.createConnection({
    host: dbConfig.mysqlHost,
    port: dbConfig.mysqlPort,
    user: dbConfig.mysqlUser,
    password: dbConfig.mysqlPass,
    database: dbConfig.mysqlDatabase
});

// Connect to MySQL
connection.connect((err) => {
    if (err) {
        console.error("Database connection failed:", err);
        process.exit(1);
    }
    console.log("Connected to MySQL successfully.");
});

/**
 * Function to fetch and parse object_data from the plugins table
 */
function getPluginData(pluginName, callback) {
    const query = 'SELECT object_data FROM plugins WHERE name = ?';

    connection.query(query, [pluginName], (err, results) => {
        if (err) {
            console.error("Query error:", err);
            callback(err, null);
            return;
        }
        if (results.length === 0) {
            console.log("No plugin found with that name.");
            callback(null, null);
            return;
        }

        try {
            const objectDataJson = JSON.parse(results[0].object_data);
            callback(null, objectDataJson);
        } catch (parseError) {
            console.error("Error parsing JSON:", parseError);
            callback(parseError, null);
        }
    });
}

// Export connection and function
module.exports = { connection, getPluginData };
