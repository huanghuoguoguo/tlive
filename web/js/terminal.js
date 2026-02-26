(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var sessionId = params.get('id');

    if (!sessionId) {
        document.getElementById('terminal').textContent = 'Error: no session ID';
        return;
    }

    var term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#4ecca3',
            selectionBackground: '#264f78',
        },
    });

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    var statusBadge = document.getElementById('session-status');
    var statusText = document.getElementById('status-text');
    var overlay = document.getElementById('disconnect-overlay');

    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProtocol + '//' + location.host + '/ws/' + sessionId;
    var ws = null;
    var reconnectTimer = null;

    function setConnected(connected) {
        if (connected) {
            statusBadge.className = 'status-badge online';
            statusText.textContent = 'Connected';
            overlay.style.display = 'none';
        } else {
            statusBadge.className = 'status-badge offline';
            statusText.textContent = 'Reconnecting...';
            overlay.style.display = 'flex';
        }
    }

    function sendResize() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'resize',
                rows: term.rows,
                cols: term.cols,
            }));
        }
    }

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
            setConnected(true);
            sendResize();
        };

        ws.onmessage = function(event) {
            var data = event.data instanceof ArrayBuffer
                ? new TextDecoder().decode(event.data)
                : event.data;
            term.write(data);
        };

        ws.onclose = function() {
            setConnected(false);
            reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = function() { ws.close(); };
    }

    term.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    term.onResize(function() { sendResize(); });
    window.addEventListener('resize', function() { fitAddon.fit(); });

    // Fetch session info for header
    fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
        var s = sessions.find(function(s) { return s.id === sessionId; });
        if (s) {
            document.getElementById('session-name').textContent = s.command + ' (PID: ' + s.pid + ') \u00b7 ' + s.duration;
        }
    });

    connect();
})();
