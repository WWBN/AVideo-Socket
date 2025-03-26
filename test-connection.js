#!/usr/bin/env node

/**
 * WebSocket Test Script (with certificate + HTTPS check + port 443 inspection)
 *
 * 1) Checks TLS certificate via handshake on WebSocket port and port 443.
 * 2) Performs a simple HTTPS GET request to verify the server on the WebSocket port.
 * 3) Tests WebSocket connection in three modes: wss:// (strict), wss:// (ignore cert), ws:// (no TLS).
 */

const WebSocket = require("ws");
const tls = require("tls");
const https = require("https");
const urlLib = require("url");
const process = require("process");

let webSocketURL = process.argv[2] || "wss://flix.avideo.com:20531";
console.log("Starting WebSocket test script...");

const testResults = [];
const fallbackUrls = [];
let certificateState = null;
let certificateState443 = null;
let httpsTestResult = null;

function buildFallbackUrls(baseUrl) {
  fallbackUrls.push({
    url: baseUrl.replace("ws://", "wss://"),
    options: { rejectUnauthorized: true },
    description: "wss:// (verify certificate)"
  });

  fallbackUrls.push({
    url: baseUrl.replace("ws://", "wss://"),
    options: { rejectUnauthorized: false },
    description: "wss:// (ignore certificate errors)"
  });

  fallbackUrls.push({
    url: baseUrl.replace("wss://", "ws://"),
    options: { rejectUnauthorized: false },
    description: "ws:// (no TLS, for test)"
  });
}

function testWebSocketConnection(url, options, description, onComplete) {
  console.log(`\nAttempting WebSocket connection:\n  URL: ${url}\n  Mode: ${description}\n`);

  const result = {
    url,
    description,
    success: false,
    error: null
  };

  let ws;
  try {
    ws = new WebSocket(url, options);

    ws.on("open", () => {
      console.log("✅ WebSocket connection established.");
      result.success = true;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch (sendErr) {
        console.error("❌ Failed to send test message:", sendErr.message);
        result.error = sendErr.message;
      }
    });

    ws.on("message", (data) => {
      console.log("📩 Received message (WebSocket):", data.toString());
    });

    ws.on("error", (err) => {
      console.error("❌ WebSocket connection error:", err.message);
      analyzeConnectionError(err);
      result.success = false;
      result.error = err.message;
      if (onComplete) onComplete(false, result);
    });

    ws.on("close", (code, reason) => {
      console.warn(`⚠️ WebSocket connection closed: Code ${code}, Reason: ${reason || "Not provided"}`);
    });

    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("🔌 Closing WebSocket test connection...");
        ws.close();
      }
      if (onComplete) onComplete(result.success, result);
    }, 5000);
  } catch (error) {
    console.error("❌ Fatal WebSocket error:", error);
    analyzeConnectionError(error);
    result.success = false;
    result.error = error.message || error;
    if (onComplete) onComplete(false, result);
  }
}

function analyzeConnectionError(err) {
  const { code, message } = err;
  let possibleCause = null;
  switch (code) {
    case "ENOTFOUND": possibleCause = "DNS lookup failed (check if the host is correct)."; break;
    case "ECONNREFUSED": possibleCause = "Connection refused by server (check if the service is running)."; break;
    case "CERT_HAS_EXPIRED": possibleCause = "SSL certificate has expired."; break;
    case "DEPTH_ZERO_SELF_SIGNED_CERT": possibleCause = "Self-signed certificate without a trusted chain."; break;
    default:
      if (message.includes("self signed certificate")) {
        possibleCause = "Self-signed or invalid certificate.";
      }
      break;
  }
  if (possibleCause) console.error("👉 Possible Cause:", possibleCause);
}

function checkCertificateState(host, port, callback) {
  const options = {
    host,
    port,
    servername: host,
    rejectUnauthorized: false
  };

  const socket = tls.connect(options, () => {
    const isAuthorized = socket.authorized;
    const authError = socket.authorizationError;
    const cert = socket.getPeerCertificate(true);

    if (!cert || Object.keys(cert).length === 0) {
      callback(new Error("No certificate returned by the server."));
      socket.end();
      return;
    }

    const certData = {
      isAuthorized,
      authError,
      subject: cert.subject,
      issuer: cert.issuer,
      valid_from: cert.valid_from,
      valid_to: cert.valid_to,
      port: port
    };

    socket.end();
    callback(null, certData);
  });

  socket.on("error", (err) => callback(err));
}

function testHttpsConnection(host, port, callback) {
  console.log(`\nAttempting simple HTTPS request at: https://${host}:${port}/ ...`);

  const options = {
    hostname: host,
    port: port,
    path: "/",
    method: "GET",
    rejectUnauthorized: true
  };

  let result = { success: false, error: null, statusCode: null };

  const req = https.request(options, (res) => {
    result.statusCode = res.statusCode;
    let data = [];
    res.on("data", chunk => data.push(chunk));
    res.on("end", () => {
      console.log(`HTTPS response: statusCode ${res.statusCode}`);
      result.success = true;
      callback(null, result);
    });
  });

  req.on("error", (err) => {
    console.error("❌ HTTPS connection error:", err.message);
    analyzeConnectionError(err);
    result.error = err.message;
    callback(err, result);
  });

  req.end();
}

function testNextUrl(index) {
  if (index >= fallbackUrls.length) {
    console.warn("🚫 All WebSocket test attempts have finished.");
    printSummary();
    return;
  }

  const { url, options, description } = fallbackUrls[index];

  testWebSocketConnection(url, options, description, (success, result) => {
    testResults.push(result);
    if (!success) {
      console.log(`Trying the next fallback (${index + 1}/${fallbackUrls.length})...`);
      testNextUrl(index + 1);
    } else {
      console.log("✅ WebSocket test succeeded in this mode.");
      testNextUrl(index + 1);
    }
  });
}

function printSummary() {
  console.log("\n==================== FINAL SUMMARY ====================");

  console.log("\n🔐 [HTTPS Test Result]");
  if (httpsTestResult) {
    if (httpsTestResult.success) {
      console.log(`✅ HTTPS GET to https://${host}:${port}/ succeeded (HTTP ${httpsTestResult.statusCode})`);
    } else {
      console.log(`❌ HTTPS GET to https://${host}:${port}/ failed`);
      console.log(`   Error: ${httpsTestResult.error}`);
    }
  } else {
    console.log("⚠️ HTTPS test was not performed.");
  }

  console.log("\n🔄 [WebSocket Test Results]");
  testResults.forEach((res, idx) => {
    const protocol = res.url.startsWith("wss://")
      ? (res.options?.rejectUnauthorized === false ? "WSS (no cert check)" : "WSS (strict cert)")
      : "WS (no TLS)";
    const status = res.success ? "✅ SUCCESS" : "❌ FAILURE";
    console.log(`\n#${idx + 1}`);
    console.log(`   URL       : ${res.url}`);
    console.log(`   Protocol  : ${protocol}`);
    console.log(`   Result    : ${status}`);
    if (res.error) {
      console.log(`   Error     : ${res.error}`);
    }
  });

  console.log("\n📜 [Certificate Inspection]");
  function printCertInfo(label, cert) {
    console.log(`\n- ${label} (Port ${cert.port})`);
    console.log(`   Authorized: ${cert.isAuthorized ? "✅ YES (Trusted by Node.js)" : "❌ NO"}`);
    if (cert.authError) {
      console.log(`   Reason    : ${cert.authError}`);
    }
    console.log(`   Subject   : ${JSON.stringify(cert.subject)}`);
    console.log(`   Issuer    : ${JSON.stringify(cert.issuer)}`);
    console.log(`   Valid From: ${cert.valid_from}`);
    console.log(`   Valid To  : ${cert.valid_to}`);
  }

  if (certificateState) printCertInfo("WebSocket Certificate", certificateState);
  else console.log("⚠️ No certificate info for WebSocket port.");

  if (certificateState443) printCertInfo("HTTPS (Port 443) Certificate", certificateState443);
  else console.log("⚠️ No certificate info for port 443.");

  const allFailed = testResults.every(r => !r.success);
  console.log("\n✅ At least one WebSocket test was successful:", !allFailed ? "YES" : "NO");
  console.log("========================================================\n");
  process.exit(0);
}

const parsed = new urlLib.URL(webSocketURL);
let host = parsed.hostname;
let port = parsed.port || (parsed.protocol === "wss:" ? 443 : 80);

console.log(`Using WebSocket URL: ${webSocketURL}`);
console.log(`Extracted Host: ${host}, Port: ${port}`);

buildFallbackUrls(webSocketURL);

checkCertificateState(host, port, (err, certData) => {
  if (err) {
    console.error(`❌ Error checking certificate on port ${port}:`, err.message);
  } else {
    certificateState = certData;
  }

  checkCertificateState(host, 443, (err443, cert443) => {
    if (err443) {
      console.error("❌ Error checking certificate on port 443:", err443.message);
    } else {
      certificateState443 = cert443;
    }

    testHttpsConnection(host, port, (httpsErr, httpsRes) => {
      httpsTestResult = httpsRes;
      testNextUrl(0);
    });
  });
});
