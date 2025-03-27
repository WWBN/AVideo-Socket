const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const entryFile = 'server.js';
const outputFile = 'dist/yptsocket';
const target = 'node18-linux-x64';
const buildInfoFile = 'dist/build-info.json';

const serverFilePath = path.resolve(entryFile);
const versionRegex = /const thisServerVersion = '(\d+)'/;

// 1. Read and increment the version
let fileContent = fs.readFileSync(serverFilePath, 'utf-8');
const match = fileContent.match(versionRegex);

if (!match) {
    console.error("❌ Could not find `thisServerVersion` declaration in server.js");
    process.exit(1);
}

const oldVersion = parseInt(match[1], 10);
const newVersion = oldVersion + 1;

// 2. Replace version in file
fileContent = fileContent.replace(versionRegex, `const thisServerVersion = '${newVersion}'`);
fs.writeFileSync(serverFilePath, fileContent, 'utf-8');

console.log(`📈 Updated thisServerVersion: ${oldVersion} → ${newVersion}`);

// 3. Create dist folder if needed
if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist');
}

// 4. Create build info file
const now = new Date();
const buildInfo = {
    version: newVersion,
    timestamp: now.getTime(),
    date: now.toISOString()
};

fs.writeFileSync(buildInfoFile, JSON.stringify(buildInfo, null, 4), 'utf-8');
console.log(`📝 Build info saved to ${buildInfoFile}`);

// 5. Build command with figlet fonts included
const cmd = `pkg ${entryFile} --targets ${target} --output ${outputFile}`;

console.log(`🔧 Building executable for Linux (target: ${target})...`);

try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✅ Build complete: ${outputFile}`);
} catch (err) {
    console.error('❌ Build failed:', err.message);
    process.exit(1);
}
