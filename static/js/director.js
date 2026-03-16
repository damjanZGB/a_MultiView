/* ═══════════════════════════════════════════════════════════════════
   a_MultiView — Director Monitor Controller
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────

let streams = [];
let switcherState = { grid_size: 4 };
const hlsInstances = {};
let ytPendingQueue = [];
let ytApiReady = false;
let ws = null;

// ── Health Monitor ──────────────────────────────────────────────

const healthMonitor = new StreamHealthMonitor({
    analysisInterval: 200,
    stallThreshold: 5000,
    silenceThreshold: 10000,
});

healthMonitor.onStatusChange((streamId, status) => {
    updateCellMeter(streamId, status);
    updateCellAlarm(streamId, status);
});

healthMonitor.start();

// ── Init ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadStreams();
    await loadSwitcherState();
    buildMultiview();
    connectWebSocket();
    bindControls();
    setSystemOnline();
});

// ── API Helpers ──────────────────────────────────────────────────

function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
}

async function api(path, method = 'GET', body = null) {
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken(),
        },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (res.status === 401) {
        window.location.href = '/login';
        return null;
    }
    return res.json();
}

async function loadStreams() {
    const data = await api('/streams');
    if (data) streams = data.streams || [];
}

async function loadSwitcherState() {
    const data = await api('/switcher/state');
    if (data) switcherState = { ...switcherState, ...data };
}

// ── WebSocket ────────────────────────────────────────────────────

function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/tally`);

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'switcher_state') {
            switcherState = { ...switcherState, ...msg.data };
        }
    };

    ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
    };
}

// ── Multiview Grid ───────────────────────────────────────────────

function buildMultiview() {
    const grid = document.getElementById('mvGrid');
    grid.innerHTML = '';
    grid.className = `mv-grid grid-${switcherState.grid_size}`;

    const cellCount = switcherState.grid_size * switcherState.grid_size;

    // Cleanup previous registrations
    streams.forEach(s => healthMonitor.unregisterStream(s.id));
    // Destroy previous HLS instances
    Object.keys(hlsInstances).forEach(key => {
        hlsInstances[key].destroy();
        delete hlsInstances[key];
    });

    for (let i = 0; i < cellCount; i++) {
        const stream = streams[i] || null;
        const cell = document.createElement('div');
        cell.className = 'mv-cell';
        cell.dataset.index = i;
        if (stream) cell.dataset.streamId = stream.id;

        // Label
        const label = document.createElement('div');
        label.className = 'mv-cell-label';
        label.textContent = stream ? stream.name : `SRC ${i + 1}`;
        cell.appendChild(label);

        // Number
        const num = document.createElement('div');
        num.className = 'mv-cell-number';
        num.textContent = i + 1;
        cell.appendChild(num);

        // Audio meter
        const meter = document.createElement('div');
        meter.className = 'stream-meter';
        meter.id = stream ? `meter-${stream.id}` : `meter-empty-${i}`;
        const meterFill = document.createElement('div');
        meterFill.className = 'meter-fill';
        meterFill.style.height = '0%';
        meter.appendChild(meterFill);
        cell.appendChild(meter);

        // Alarm overlay
        const alarm = document.createElement('div');
        alarm.className = 'stream-alarm';
        alarm.id = stream ? `alarm-${stream.id}` : `alarm-empty-${i}`;
        const alarmText = document.createElement('span');
        alarmText.className = 'alarm-text';
        alarm.appendChild(alarmText);
        cell.appendChild(alarm);

        if (stream) {
            initCellStream(cell, stream);
        } else {
            const empty = document.createElement('div');
            empty.className = 'mv-cell-empty';
            empty.textContent = '+ ADD';
            cell.appendChild(empty);
            meter.style.display = 'none';
        }

        // Right-click: edit / add
        cell.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (stream) {
                openEditDialog(stream);
            } else {
                openAddDialog();
            }
        });

        // Click on empty cell: add
        if (!stream) {
            cell.addEventListener('click', openAddDialog);
        }

        grid.appendChild(cell);
    }
}

function initCellStream(cell, stream) {
    const isYT = stream.stream_type === 'youtube';

    if (isYT) {
        const ytDiv = document.createElement('div');
        ytDiv.id = `mv-yt-${stream.id}`;
        ytDiv.style.position = 'absolute';
        ytDiv.style.inset = '0';
        ytDiv.style.width = '100%';
        ytDiv.style.height = '100%';
        cell.appendChild(ytDiv);

        if (ytApiReady) {
            createYTPlayer(stream.id, ytDiv.id);
        } else {
            ytPendingQueue.push({ streamId: stream.id, containerId: ytDiv.id });
            ensureYTApi();
        }

        // YouTube: show status dot instead of audio meter (can't analyze cross-origin audio)
        const meter = cell.querySelector('.stream-meter');
        if (meter) {
            meter.innerHTML = '<div class="meter-status"><div class="meter-status-dot buffering" id="yt-status-' + stream.id + '"></div></div>';
        }
    } else {
        const video = document.createElement('video');
        video.className = 'mv-cell-video';
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        cell.appendChild(video);

        if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            hls.loadSource(stream.url);
            hls.attachMedia(video);
            hlsInstances[`mv-${stream.id}`] = hls;

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(() => {});
                healthMonitor.registerHlsStream(stream.id, video, hls);
            });

            hls.on(Hls.Events.ERROR, (_e, data) => {
                if (data.fatal) {
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                }
            });
        }
    }
}

// ── Health Monitor UI Updates ────────────────────────────────────

function updateCellMeter(streamId, status) {
    // HLS: update audio level bar
    if (status.type === 'hls') {
        const meter = document.getElementById(`meter-${streamId}`);
        if (!meter) return;
        const fill = meter.querySelector('.meter-fill');
        if (!fill) return;
        const pct = Math.min(status.audioLevel * 100 * 2, 100);
        fill.style.height = `${pct}%`;
    }

    // YouTube: update status dot
    if (status.type === 'youtube') {
        const dot = document.getElementById(`yt-status-${streamId}`);
        if (!dot) return;
        dot.className = 'meter-status-dot';
        if (status.alarms.includes('NO SIGNAL') || status.alarms.includes('STALLED')) {
            dot.classList.add('error');
        } else if (status.alarms.includes('BUFFERING')) {
            dot.classList.add('buffering');
        }
        // default: green (healthy)
    }
}

function updateCellAlarm(streamId, status) {
    const alarm = document.getElementById(`alarm-${streamId}`);
    if (!alarm) return;
    const text = alarm.querySelector('.alarm-text');

    if (status.alarms.length > 0) {
        const priority = ['NO SIGNAL', 'STALLED', 'NO AUDIO'];
        const top = priority.find(a => status.alarms.includes(a)) || status.alarms[0];
        text.textContent = top;
        alarm.classList.add('active');
    } else {
        alarm.classList.remove('active');
        text.textContent = '';
    }
}

// ── YouTube API ──────────────────────────────────────────────────

function ensureYTApi() {
    if (document.getElementById('yt-api-script')) return;
    const tag = document.createElement('script');
    tag.id = 'yt-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
        ytApiReady = true;
        ytPendingQueue.forEach(p => createYTPlayer(p.streamId, p.containerId));
        ytPendingQueue = [];
    };
}

function createYTPlayer(streamId, containerId) {
    const stream = streams.find(s => s.id === streamId);
    if (!stream) return;

    const ytId = extractYouTubeId(stream.url);
    if (!ytId) return;

    const player = new YT.Player(containerId, {
        width: '100%',
        height: '100%',
        videoId: ytId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
            autoplay: 1,
            mute: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
            // Force live edge playback
            live: 1,
        },
        events: {
            onReady: (e) => {
                const iframe = e.target.getIframe();
                if (iframe) {
                    iframe.style.width = '100%';
                    iframe.style.height = '100%';
                    iframe.style.position = 'absolute';
                    iframe.style.inset = '0';
                }
                e.target.playVideo();
                // Seek to live edge
                try {
                    const duration = e.target.getDuration();
                    if (duration > 0) {
                        e.target.seekTo(duration, true);
                    }
                } catch (err) {}
                healthMonitor.registerYoutubeStream(streamId, e.target);
            },
            onStateChange: (e) => {
                // When buffering completes or video plays, seek to live edge
                if (e.data === YT.PlayerState.PLAYING) {
                    const dot = document.getElementById(`yt-status-${streamId}`);
                    if (dot) { dot.className = 'meter-status-dot'; }
                } else if (e.data === YT.PlayerState.BUFFERING) {
                    const dot = document.getElementById(`yt-status-${streamId}`);
                    if (dot) { dot.className = 'meter-status-dot buffering'; }
                }
            },
            onError: (e) => {
                console.error('YT error:', e.data);
                const dot = document.getElementById(`yt-status-${streamId}`);
                if (dot) { dot.className = 'meter-status-dot error'; }
            },
        },
    });
}

function extractYouTubeId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/i,
        /(?:youtube\.com\/embed\/)([^/?]+)/i,
        /(?:youtube\.com\/live\/)([^/?]+)/i,
        /(?:youtu\.be\/)([^/?]+)/i,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// ── Controls Binding ─────────────────────────────────────────────

function bindControls() {
    // Add Stream dialog
    document.getElementById('btnAddStream').addEventListener('click', openAddDialog);
    document.getElementById('dlgStreamCancel').addEventListener('click', () => {
        document.getElementById('streamDialog').close();
    });
    document.getElementById('streamForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('dlgStreamName').value.trim();
        const url = document.getElementById('dlgStreamUrl').value.trim();
        if (!name || !url) return;

        await api('/streams', 'POST', { name, url });
        document.getElementById('streamDialog').close();
        document.getElementById('dlgStreamName').value = '';
        document.getElementById('dlgStreamUrl').value = '';
        await loadStreams();
        buildMultiview();
    });

    // Edit Stream dialog
    document.getElementById('editStreamCancel').addEventListener('click', () => {
        document.getElementById('editStreamDialog').close();
    });
    document.getElementById('editStreamDelete').addEventListener('click', async () => {
        const id = document.getElementById('editStreamId').value;
        if (id && confirm('Delete this source?')) {
            await api(`/streams/${id}`, 'DELETE');
            document.getElementById('editStreamDialog').close();
            await loadStreams();
            buildMultiview();
        }
    });
    document.getElementById('editStreamForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editStreamId').value;
        const name = document.getElementById('editStreamName').value.trim();
        const url = document.getElementById('editStreamUrl').value.trim();
        if (!id || !name || !url) return;

        await api(`/streams/${id}`, 'PUT', { name, url });
        document.getElementById('editStreamDialog').close();
        await loadStreams();
        buildMultiview();
    });

    // Presets dialog
    document.getElementById('btnPresets').addEventListener('click', openPresetsDialog);
    document.getElementById('presetsClose').addEventListener('click', () => {
        document.getElementById('presetsDialog').close();
    });

    // Save Preset dialog
    document.getElementById('btnSavePreset').addEventListener('click', () => {
        document.getElementById('savePresetDialog').showModal();
    });
    document.getElementById('savePresetCancel').addEventListener('click', () => {
        document.getElementById('savePresetDialog').close();
    });
    document.getElementById('savePresetForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('presetNameInput').value.trim();
        if (!name) return;

        const items = streams.map((s, i) => ({ stream_id: s.id, position: i }));
        await api('/presets', 'POST', { name, items });
        document.getElementById('savePresetDialog').close();
        document.getElementById('presetNameInput').value = '';
    });
}

// ── Dialog Helpers ───────────────────────────────────────────────

function openAddDialog() {
    document.getElementById('dlgStreamName').value = '';
    document.getElementById('dlgStreamUrl').value = '';
    document.getElementById('streamDialog').showModal();
}

function openEditDialog(stream) {
    document.getElementById('editStreamId').value = stream.id;
    document.getElementById('editStreamName').value = stream.name;
    document.getElementById('editStreamUrl').value = stream.url;
    document.getElementById('editStreamDialog').showModal();
}

async function openPresetsDialog() {
    const data = await api('/presets');
    const list = document.getElementById('presetsList');
    list.innerHTML = '';

    if (!data?.presets?.length) {
        list.innerHTML = '<div class="presets-empty">No presets saved</div>';
    } else {
        data.presets.forEach(preset => {
            const item = document.createElement('div');
            item.className = 'preset-item';
            item.innerHTML = `
                <span class="preset-item-name">${escapeHtml(preset.name)}</span>
                <div class="preset-item-actions">
                    <button class="preset-item-btn load" data-id="${preset.id}">LOAD</button>
                    <button class="preset-item-btn delete" data-id="${preset.id}">DEL</button>
                </div>
            `;
            item.querySelector('.load').addEventListener('click', async (e) => {
                e.stopPropagation();
                await api(`/presets/${preset.id}/load`, 'POST');
                await loadStreams();
                await loadSwitcherState();
                buildMultiview();
                document.getElementById('presetsDialog').close();
            });
            item.querySelector('.delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete preset "${preset.name}"?`)) {
                    await api(`/presets/${preset.id}`, 'DELETE');
                    openPresetsDialog();
                }
            });
            list.appendChild(item);
        });
    }

    document.getElementById('presetsDialog').showModal();
}

// ── Utilities ────────────────────────────────────────────────────

function setSystemOnline() {
    const el = document.getElementById('systemLabel');
    el.textContent = 'ONLINE';
    el.classList.add('online');
}

function isDialogOpen() {
    return document.querySelector('dialog[open]') !== null;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
