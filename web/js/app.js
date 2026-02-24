(function() {
    'use strict';

    var sessionsEl = document.getElementById('sessions');
    var emptyMsg = document.getElementById('empty-msg');

    if (!sessionsEl) return;

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function loadSessions() {
        fetch('/api/sessions')
            .then(function(resp) { return resp.json(); })
            .then(function(sessions) {
                if (!sessions || sessions.length === 0) {
                    sessionsEl.innerHTML = '';
                    emptyMsg.style.display = 'block';
                    return;
                }
                emptyMsg.style.display = 'none';
                sessionsEl.innerHTML = sessions.map(function(s) {
                    return '<div class="session-card" onclick="location.href=\'/terminal.html?id=' + s.id + '\'">' +
                        '<div class="name">' + escapeHtml(s.command) + '</div>' +
                        '<div class="meta">PID: ' + s.pid + ' · ' + s.duration + ' · ' + s.status + '</div>' +
                        '<div class="preview">' + escapeHtml(s.last_output || '(no output)') + '</div>' +
                        '</div>';
                }).join('');
            })
            .catch(function(e) { console.error('Failed to load sessions:', e); });
    }

    loadSessions();
    setInterval(loadSessions, 3000);
})();
