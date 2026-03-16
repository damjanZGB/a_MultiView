/* ═══════════════════════════════════════════════════════════════════
   a_MultiView — Director Monitor Controller
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────

let streams = [];
let switcherState = { pgm: null, pvw: null, grid_size: 4, transition_type: 'cut', transition_duration: 500 };
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
    updateMonitorMeter(streamId, status);
});

healthMonitor.start();

// ── Init ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadStreams();
    await loadSwitcherState();
    buildMultiview();
    buildSourceButtons();
    updateTally();
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
            updateTally();
            updateMonitors();
            updateSourceButtons();
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

    // Unregister all streams from health monitor before rebuilding
    streams.forEach(s => healthMonitor.unregisterStream(s.id));

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

        // Tally dot
        const tally = document.createElement('div');
        tally.className = 'mv-cell-tally';
        cell.appendChild(tally);

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
            // Hide meter on empty cells
            meter.style.display = 'none';
        }

        // Click: set as PVW
        cell.addEventListener('click', () => {
            if (stream) {
                api('/switcher/pvw', 'POST', { stream_id: stream.id });
            }
        });

        // Right-click: edit
        cell.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (stream) {
                openEditDialog(stream);
            } else {
                openAddDialog();
            }
        });

        grid.appendChild(cell);
    }

    updateTally();
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

        // Show N/A on meter for YouTube (no audio analysis possible)
        const meter = cell.querySelector('.stream-meter');
        if (meter) {
            meter.innerHTML = '<div class="meter-na">YT</div>';
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
                // Register with health monitor after playback starts
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
    const meter = document.getElementById(`meter-${streamId}`);
    if (!meter) return;
    const fill = meter.querySelector('.meter-fill');
    if (!fill) return;

    if (status.type === 'youtube' || status.audioLevel < 0) return;

    const pct = Math.min(status.audioLevel * 100 * 2, 100); // amplify for visibility
    fill.style.height = `${pct}%`;
}

function updateCellAlarm(streamId, status) {
    const alarm = document.getElementById(`alarm-${streamId}`);
    if (!alarm) return;
    const text = alarm.querySelector('.alarm-text');

    if (status.alarms.length > 0) {
        // Priority: NO SIGNAL > STALLED > NO AUDIO
        const priority = ['NO SIGNAL', 'STALLED', 'NO AUDIO'];
        const top = priority.find(a => status.alarms.includes(a)) || status.alarms[0];
        text.textContent = top;
        alarm.classList.add('active');
    } else {
        alarm.classList.remove('active');
        text.textContent = '';
    }
}

function updateMonitorMeter(streamId, status) {
    // Update PGM meter if this stream is on PGM
    if (switcherState.pgm?.id === streamId) {
        const fill = document.getElementById('pgmMeterFill');
        if (fill && status.audioLevel >= 0) {
            fill.style.height = `${Math.min(status.audioLevel * 200, 100)}%`;
        }
    }
    // Update PVW meter if this stream is on PVW
    if (switcherState.pvw?.id === streamId) {
        const fill = document.getElementById('pvwMeterFill');
        if (fill && status.audioLevel >= 0) {
            fill.style.height = `${Math.min(status.audioLevel * 200, 100)}%`;
        }
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
        playerVars: { autoplay: 1, mute: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
        events: {
            onReady: (e) => {
                // Ensure the iframe fills the cell
                const iframe = e.target.getIframe();
                if (iframe) {
                    iframe.style.width = '100%';
                    iframe.style.height = '100%';
                    iframe.style.position = 'absolute';
                    iframe.style.inset = '0';
                }
                e.target.playVideo();
                healthMonitor.registerYoutubeStream(streamId, e.target);
            },
            onError: (e) => console.error('YT error:', e),
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

// ── PGM / PVW Monitors ──────────────────────────────────────────

function updateMonitors() {
    updateMonitor('pgm', switcherState.pgm);
    updateMonitor('pvw', switcherState.pvw);
}

function updateMonitor(type, streamData) {
    const screen = document.getElementById(`${type}Screen`);
    const label = document.getElementById(`${type}Label`);

    // Preserve the meter element
    const meterId = `${type}Meter`;
    const meterFillId = `${type}MeterFill`;

    // Clear existing content except meter
    const meter = document.getElementById(meterId);
    screen.innerHTML = '';
    label.textContent = '—';

    // Re-add meter
    if (meter) {
        screen.appendChild(meter);
    } else {
        const newMeter = document.createElement('div');
        newMeter.className = 'monitor-meter';
        newMeter.id = meterId;
        const newFill = document.createElement('div');
        newFill.className = 'meter-fill';
        newFill.id = meterFillId;
        newMeter.appendChild(newFill);
        screen.appendChild(newMeter);
    }

    // Reset meter
    const fill = document.getElementById(meterFillId);
    if (fill) fill.style.height = '0%';

    if (!streamData) {
        const ph = document.createElement('div');
        ph.className = 'monitor-placeholder';
        ph.textContent = 'NO SIGNAL';
        screen.appendChild(ph);
        return;
    }

    label.textContent = streamData.name;

    if (streamData.stream_type === 'youtube') {
        const ytId = extractYouTubeId(streamData.url);
        if (ytId) {
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.allowFullscreen = true;
            iframe.style.border = 'none';
            screen.appendChild(iframe);
        }
    } else {
        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        screen.appendChild(video);

        if (Hls.isSupported()) {
            const key = `${type}-monitor`;
            if (hlsInstances[key]) hlsInstances[key].destroy();

            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            hls.loadSource(streamData.url);
            hls.attachMedia(video);
            hlsInstances[key] = hls;

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(() => {});
            });
        }
    }
}

// ── Tally ────────────────────────────────────────────────────────

function updateTally() {
    const pgmId = switcherState.pgm?.id;
    const pvwId = switcherState.pvw?.id;

    // Update MV cells
    document.querySelectorAll('.mv-cell').forEach(cell => {
        cell.classList.remove('tally-pgm', 'tally-pvw');
        const sid = parseInt(cell.dataset.streamId);
        if (sid === pgmId) cell.classList.add('tally-pgm');
        else if (sid === pvwId) cell.classList.add('tally-pvw');
    });

    // Update PGM label
    document.getElementById('pgmLabel').textContent = switcherState.pgm?.name || '—';
    document.getElementById('pvwLabel').textContent = switcherState.pvw?.name || '—';

    updateMonitors();
}

// ── Source Buttons ───────────────────────────────────────────────

function buildSourceButtons() {
    const pgmRow = document.getElementById('pgmButtons');
    const pvwRow = document.getElementById('pvwButtons');
    pgmRow.innerHTML = '';
    pvwRow.innerHTML = '';

    streams.forEach(stream => {
        // PGM button
        const pgmBtn = document.createElement('button');
        pgmBtn.className = 'src-btn';
        pgmBtn.textContent = stream.name;
        pgmBtn.title = stream.name;
        pgmBtn.dataset.streamId = stream.id;
        if (switcherState.pgm?.id === stream.id) pgmBtn.classList.add('active');
        pgmBtn.addEventListener('click', () => {
            api('/switcher/pgm', 'POST', { stream_id: stream.id });
        });
        pgmRow.appendChild(pgmBtn);

        // PVW button
        const pvwBtn = document.createElement('button');
        pvwBtn.className = 'src-btn';
        pvwBtn.textContent = stream.name;
        pvwBtn.title = stream.name;
        pvwBtn.dataset.streamId = stream.id;
        if (switcherState.pvw?.id === stream.id) pvwBtn.classList.add('active');
        pvwBtn.addEventListener('click', () => {
            api('/switcher/pvw', 'POST', { stream_id: stream.id });
        });
        pvwRow.appendChild(pvwBtn);
    });
}

function updateSourceButtons() {
    document.querySelectorAll('#pgmButtons .src-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.streamId) === switcherState.pgm?.id);
    });
    document.querySelectorAll('#pvwButtons .src-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.streamId) === switcherState.pvw?.id);
    });
}

// ── Controls Binding ─────────────────────────────────────────────

function bindControls() {
    // CUT
    document.getElementById('btnCut').addEventListener('click', async () => {
        const indicator = document.getElementById('transIndicator');
        indicator.classList.add('transitioning');
        await api('/switcher/cut', 'POST');
        setTimeout(() => indicator.classList.remove('transitioning'), 300);
    });

    // AUTO
    document.getElementById('btnAuto').addEventListener('click', async () => {
        const indicator = document.getElementById('transIndicator');
        indicator.classList.add('transitioning');
        const result = await api('/switcher/auto', 'POST');
        const dur = result?.duration || 500;
        setTimeout(() => indicator.classList.remove('transitioning'), dur);
    });

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
        buildSourceButtons();
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
            buildSourceButtons();
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
        buildSourceButtons();
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

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Space = CUT
        if (e.code === 'Space' && !isDialogOpen()) {
            e.preventDefault();
            document.getElementById('btnCut').click();
        }
        // Enter = AUTO
        if (e.code === 'Enter' && !isDialogOpen()) {
            e.preventDefault();
            document.getElementById('btnAuto').click();
        }
        // 1-9 = PVW source select
        if (e.key >= '1' && e.key <= '9' && !isDialogOpen()) {
            const idx = parseInt(e.key) - 1;
            if (streams[idx]) {
                api('/switcher/pvw', 'POST', { stream_id: streams[idx].id });
            }
        }
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
                buildSourceButtons();
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
