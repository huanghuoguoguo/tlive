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
        fontFamily: "'Cascadia Mono', 'Cascadia Code', 'MesloLGS NF', 'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#4ecca3',
            selectionBackground: '#264f78',
        },
        allowProposedApi: true,
    });

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    var termEl = document.getElementById('terminal');
    term.open(termEl);

    var statusBadge = document.getElementById('session-status');
    var statusText = document.getElementById('status-text');
    var overlay = document.getElementById('disconnect-overlay');

    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var tokenParam = params.get('token') ||
        (document.cookie.match(/(?:^|;\s*)tl_token=([^;]*)/) || [])[1] || '';
    var wsUrl = wsProtocol + '//' + location.host + '/ws/session/' + sessionId + '?token=' + tokenParam;
    var backLink = document.getElementById('back-link');
    if (backLink && tokenParam) {
        backLink.href = '/?token=' + encodeURIComponent(tokenParam);
    }
    var ws = null;
    var reconnectTimer = null;
    var processExited = false;

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

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
            setConnected(true);
            fitAddon.fit();
        };

        ws.onmessage = function(event) {
            if (typeof event.data === 'string') {
                try {
                    var ctrl = JSON.parse(event.data);
                    if (ctrl.type === 'exit') {
                        processExited = true;
                        showExitOverlay(ctrl.code);
                        return;
                    }
                    // Ignore size messages — web viewer fits to its own viewport
                    if (ctrl.type === 'size') {
                        return;
                    }
                } catch(e) { /* not JSON, treat as terminal data */ }
                term.write(event.data);
                return;
            }
            var data = new TextDecoder().decode(event.data);
            term.write(data);
        };

        ws.onclose = function() {
            if (processExited) return;
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

    window.addEventListener('resize', function() {
        fitAddon.fit();
    });

    // Fetch session info for header
    fetch('/api/sessions', { headers: { 'Authorization': 'Bearer ' + tokenParam } }).then(function(r) { return r.json(); }).then(function(sessions) {
        var s = sessions.find(function(s) { return s.id === sessionId; });
        if (s) {
            document.getElementById('session-name').textContent = s.command + ' (PID: ' + s.pid + ') \u00b7 ' + s.duration;
        }
    });

    function showExitOverlay(code) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        statusBadge.className = 'status-badge offline';
        statusText.textContent = 'Exited';
        var content = overlay.querySelector('.disconnect-content');
        content.innerHTML =
            '<div class="disconnect-icon">&#9209;</div>' +
            '<p>Process exited (code ' + code + ')</p>' +
            '<p class="disconnect-hint">Redirecting to dashboard...</p>';
        overlay.style.display = 'flex';
        setTimeout(function() {
            window.location.href = '/' + (tokenParam ? '?token=' + encodeURIComponent(tokenParam) : '');
        }, 3000);
    }

    connect();
})();
