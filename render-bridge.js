const http = require('http');
const https = require('https');

console.log('[Interceptor] 🛡️ Network Hijack Active: api.telegram.org -> 127.0.0.1:7860/fake-tg');

// 1. Intercept native fetch (Used by modern frameworks)
const originalFetch = global.fetch;
if (originalFetch) {
    global.fetch = async function(url, options) {
        let urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('api.telegram.org')) {
            urlStr = urlStr.replace('https://api.telegram.org', 'http://127.0.0.1:7860/fake-tg');
            return originalFetch(urlStr, options);
        }
        return originalFetch(url, options);
    };
}

// 2. Intercept https.request (Used by older Telegram SDKs like telegraf)
const originalRequest = https.request;
https.request = function(options, ...args) {
    let host = options.hostname || options.host || (typeof options === 'string' ? new URL(options).hostname : '');
    
    if (host === 'api.telegram.org' || (typeof options === 'string' && options.includes('api.telegram.org'))) {
        if (typeof options === 'string') {
            options = options.replace('https://api.telegram.org', 'http://127.0.0.1:7860/fake-tg');
            return http.request(options, ...args); // Downgrade to HTTP for local tunnel
        } else {
            options.protocol = 'http:';
            options.hostname = '127.0.0.1';
            options.host = '127.0.0.1';
            options.port = 7860;
            options.path = '/fake-tg' + options.path;
            return http.request(options, ...args);
        }
    }
    return originalRequest.call(https, options, ...args);
};
