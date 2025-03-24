const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const entryFile = 'server.js';
const outputFile = 'dist/yptsocket';
const target = 'node18-linux-x64';

// Create dist directory if it doesn't exist
if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist');
}

// Build command using pkg
const cmd = `pkg ${entryFile} --targets ${target} --output ${outputFile}`;

console.log(`🔧 Building executable for Linux (target: ${target})...`);

try {
    // Run build command
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✅ Build complete: ${outputFile}`);
} catch (err) {
    console.error('❌ Build failed:', err.message);
    process.exit(1);
}
