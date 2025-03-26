#!/usr/bin/env node

/**
 * WebSocket Test Script (with summary)
 *
 * Attempts to connect to the provided WebSocket URL in different ways.
 * If no URL is provided, it attempts to retrieve it from the database (using the "getPluginData" function).
 * Tries to detect and report the reason for failures, then shows a final summary.
 */

const WebSocket = require("ws");

// Get WebSocket URL from command-line argument
let webSocketURL = process.argv[2];

if(!webSocketURL){
    webSocketURL = 'wss://flix.avideo.com:20531';
}

console.log("🔍 Debugging: Starting WebSocket test script...");

// Array para armazenar resultados das tentativas
const testResults = [];

// Array de fallback (diferentes abordagens de conexão)
const fallbackUrls = [];

/**
 * Adiciona diferentes abordagens de conexão ao fallbackUrls
 * 1) wss com verificação de certificado
 * 2) wss ignorando erros de certificado
 * 3) ws sem TLS
 *
 * @param {string} baseUrl
 */
function buildFallbackUrls(baseUrl) {
    // 1) wss com verificação de certificado (padrão)
    fallbackUrls.push({
        url: baseUrl.replace("ws://", "wss://"),
        options: { rejectUnauthorized: true },
        description: "wss:// (verificação de certificado habilitada)"
    });

    // 2) wss ignorando erros de certificado
    fallbackUrls.push({
        url: baseUrl.replace("ws://", "wss://"),
        options: { rejectUnauthorized: false },
        description: "wss:// (ignorar erros de certificado)"
    });

    // 3) ws (não seguro, apenas teste)
    fallbackUrls.push({
        url: baseUrl.replace("wss://", "ws://"),
        options: { rejectUnauthorized: false },
        description: "ws:// (sem TLS, para teste)"
    });
}

/**
 * Testa uma única conexão WebSocket
 *
 * @param {string} url
 * @param {object} options
 * @param {string} description
 * @param {function} onComplete - callback indicando sucesso/falha
 */
function testWebSocketConnection(url, options, description, onComplete) {
    console.log(`\n🔄 Tentando conectar: ${url}\nModo: ${description}\n`);

    // Objeto para registrar o resultado desta tentativa
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
            console.log("✅ Conexão estabelecida com sucesso!");
            result.success = true;
            try {
                // Envia mensagem de teste
                ws.send(JSON.stringify({ type: "ping" }));
            } catch (sendErr) {
                console.error("❌ Falha ao enviar mensagem de teste:", sendErr.message);
                result.error = sendErr.message;
            }
        });

        ws.on("message", (data) => {
            console.log("📩 Mensagem recebida:", data.toString());
        });

        ws.on("error", (err) => {
            console.error("❌ Falha na conexão:", err.message);
            analyzeConnectionError(err);
            result.success = false;
            result.error = err.message;
            if (onComplete) {
                onComplete(false, result);
            }
        });

        ws.on("close", (code, reason) => {
            console.warn(`⚠️ Conexão encerrada: Código ${code}, Razão: ${reason || "Motivo não fornecido"}`);
        });

        // Fecha a conexão após 5 segundos
        setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                console.log("🔌 Encerrando conexão de teste...");
                ws.close();
            }
            // Se não houve erro antes, a conexão foi bem-sucedida
            if (onComplete) {
                onComplete(result.success, result);
            }
        }, 5000);

    } catch (error) {
        console.error("❌ Erro fatal:", error);
        analyzeConnectionError(error);
        result.success = false;
        result.error = error.message || error;
        if (onComplete) {
            onComplete(false, result);
        }
    }
}

/**
 * Analisa possíveis códigos de erro
 *
 * @param {Error} err
 */
function analyzeConnectionError(err) {
    const { code, message } = err;
    let possibleCause = null;

    switch (code) {
        case "ENOTFOUND":
            possibleCause = "DNS não encontrado (verifique se o host está correto).";
            break;
        case "ECONNREFUSED":
            possibleCause = "Conexão recusada pelo servidor (cheque se o serviço está ativo).";
            break;
        case "CERT_HAS_EXPIRED":
            possibleCause = "Certificado SSL expirado.";
            break;
        case "DEPTH_ZERO_SELF_SIGNED_CERT":
            possibleCause = "Certificado autoassinado sem cadeia de confiança.";
            break;
        default:
            // Em alguns casos, err.code pode estar vazio, então tenta-se usar a mensagem
            if (message.includes("self signed certificate")) {
                possibleCause = "Certificado autoassinado ou inválido.";
            }
            break;
    }

    if (possibleCause) {
        console.error("👉 Possível Motivo:", possibleCause);
    }
}

// Se foi fornecida uma URL, testa diretamente com fallback
if (webSocketURL) {
    console.log(`🔍 Usando URL WebSocket fornecida: ${webSocketURL}`);
    buildFallbackUrls(webSocketURL);
    testNextUrl(0);
} else {
    console.log("\n📡 Tentando recuperar URL WebSocket do banco de dados...");

    // Import MySQL only if needed
    const { getPluginData } = require("./mysql");

    getPluginData("YPTSocket", (err, pluginData) => {
        if (err || !pluginData) {
            console.error("❌ Falha ao recuperar detalhes do WebSocket no banco de dados:", err);
            process.exit(1);
        }

        // Monta a URL base e fallback
        webSocketURL = `wss://${pluginData.host}:${pluginData.port}`;
        console.log(`✅ Recuperado WebSocket URL do banco: ${webSocketURL}`);
        buildFallbackUrls(webSocketURL);
        testNextUrl(0);
    });
}

/**
 * Função recursiva para testar URLs de fallback em sequência
 *
 * @param {number} index
 */
function testNextUrl(index) {
    if (index >= fallbackUrls.length) {
        console.warn("🚫 Todas as tentativas de conexão foram finalizadas.");
        printSummary();
        return;
    }

    const { url, options, description } = fallbackUrls[index];

    testWebSocketConnection(url, options, description, (success, result) => {
        // Armazena o resultado
        testResults.push(result);

        // Se falhou, tenta próxima abordagem
        if (!success) {
            console.log(`🔃 Tentando próximo fallback (${index + 1} de ${fallbackUrls.length - 1})...`);
            testNextUrl(index + 1);
        } else {
            console.log("✅ Teste concluído com sucesso nesta abordagem.");
            // Mesmo que tenha dado certo, pode-se continuar testando as demais
            // ou encerrar aqui. Abaixo, encerro o fluxo após sucesso:
            printSummary();
        }
    });
}

/**
 * Exibe um resumo final do teste
 */
function printSummary() {
    console.log("\n===== RESUMO FINAL =====");
    testResults.forEach((res, idx) => {
        console.log(`\nTentativa #${idx + 1}`);
        console.log(`- URL: ${res.url}`);
        console.log(`- Modo: ${res.description}`);
        if (res.success) {
            console.log("- Resultado: SUCESSO");
        } else {
            console.log("- Resultado: FALHA");
            if (res.error) {
                console.log(`- Erro: ${res.error}`);
            }
        }
    });
    console.log("========================\n");
}
