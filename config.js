const fs = require('fs');
const path = require('path');

// Base directory of this script file
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// List of possible configuration paths (first one relative to this file)
const possiblePaths = [
    path.join(baseDir, '../../../videos/configuration.php'),
    '/var/www/html/AVideo/videos/configuration.php',
    '/var/www/AVideo/videos/configuration.php',
    '/var/www/html/.compose/videos/configuration.php'
];

// Function to parse PHP config file and extract MySQL credentials
function parsePHPConfig(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Função para extrair valor com fallback opcional
        const getMatch = (regex, label, defaultValue = null) => {
            const match = content.match(regex);
            if (!match) {
                if (defaultValue !== null) return defaultValue;
                throw new Error(`Missing ${label} in config`);
            }
            return match[1];
        };

        const mysqlHost = getMatch(/\$mysqlHost\s*=\s*'([^']+)'/, 'mysqlHost');
        const mysqlPort = getMatch(/\$mysqlPort\s*=\s*'([^']+)'/, 'mysqlPort', '3306');
        const mysqlUser = getMatch(/\$mysqlUser\s*=\s*'([^']+)'/, 'mysqlUser');
        const mysqlPass = getMatch(/\$mysqlPass\s*=\s*'([^']+)'/, 'mysqlPass');
        const mysqlDatabase = getMatch(/\$mysqlDatabase\s*=\s*'([^']+)'/, 'mysqlDatabase');
        const systemRootPath = getMatch(/\$global\['systemRootPath'\]\s*=\s*'([^']+)'/, 'systemRootPath');


        return { mysqlHost, mysqlPort, mysqlUser, mysqlPass, mysqlDatabase, systemRootPath };
    } catch (error) {
        console.error(`❌ Error reading PHP config from ${filePath}: ${error.message}`);
        return null;
    }
}

// Try multiple paths until one works
function tryParsePHPConfig() {
    for (const absolutePath of possiblePaths) {
        if (fs.existsSync(absolutePath)) {
            console.log(`🔍 Trying configuration file: ${absolutePath}`);

            const dbConfig = parsePHPConfig(absolutePath);

            if (dbConfig) {
                console.log(`✅ Successfully loaded configuration from: ${absolutePath}`);
                return dbConfig;
            } else {
                console.warn(`⚠️ Skipping invalid config file: ${absolutePath}`);
            }
        } else {
            console.warn(`❌ File not found: ${absolutePath}`);
        }
    }

    console.error("❌ Failed to load configuration from all known paths.");
    process.exit(1);
}


// Execute
const config = tryParsePHPConfig();
module.exports = config; // ✅ instead of { dbConfig: config }

