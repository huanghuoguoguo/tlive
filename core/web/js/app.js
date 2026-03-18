(function() {
    'use strict';

    var sessionsEl = document.getElementById('sessions');
    var emptyMsg = document.getElementById('empty-msg');
    var countBadge = document.getElementById('session-count');
    var statusBadge = document.getElementById('status');
    var loaded = false;
    var tokenParam = new URLSearchParams(window.location.search).get('token') || '';

    if (!sessionsEl) return;

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function showSkeletons() {
        var html = '';
        for (var i = 0; i < 2; i++) {
            html += '<div class="skeleton-card">' +
                '<div class="skeleton-line short"></div>' +
                '<div class="skeleton-line medium"></div>' +
                '<div class="skeleton-line long"></div>' +
                '</div>';
        }
        sessionsEl.innerHTML = html;
    }

    function loadSessions() {
        fetch('/api/sessions', { headers: { 'Authorization': 'Bearer ' + tokenParam } })
            .then(function(resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            })
            .then(function(sessions) {
                loaded = true;
                statusBadge.className = 'status-badge online';
                statusBadge.querySelector('.status-text').textContent = 'Connected';

                if (!sessions || sessions.length === 0) {
                    sessionsEl.innerHTML = '';
                    emptyMsg.style.display = 'block';
                    countBadge.textContent = '0';
                    return;
                }
                emptyMsg.style.display = 'none';
                countBadge.textContent = sessions.length;
                sessionsEl.innerHTML = sessions.map(function(s) {
                    return '<div class="session-card" onclick="location.href=\'/terminal.html?id=' + s.id + '&token=' + tokenParam + '\'">' +
                        '<div class="card-header">' +
                            '<span class="name">' + escapeHtml(s.command) + '</span>' +
                            '<span class="card-status">' + escapeHtml(s.status) + '</span>' +
                        '</div>' +
                        '<div class="meta">PID ' + s.pid + ' &middot; ' + escapeHtml(s.duration) + '</div>' +
                        '<div class="preview">' + escapeHtml(s.last_output || '(no output)') + '</div>' +
                        '</div>';
                }).join('');
            })
            .catch(function(e) {
                console.error('Failed to load sessions:', e);
                statusBadge.className = 'status-badge offline';
                statusBadge.querySelector('.status-text').textContent = 'Disconnected';
            });
    }

    showSkeletons();
    loadSessions();
    setInterval(loadSessions, 3000);
})();
