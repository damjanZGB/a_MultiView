/* ═══════════════════════════════════════════════════════════════════
   Stream Health Monitor — Audio metering, stall & silence detection
   ═══════════════════════════════════════════════════════════════════ */

class StreamHealthMonitor {
    constructor(opts = {}) {
        this.analysisInterval = opts.analysisInterval || 200;   // ms
        this.stallThreshold   = opts.stallThreshold   || 5000;  // ms with no timeupdate
        this.silenceThreshold = opts.silenceThreshold || 10000; // ms of silence → alarm
        this.silenceFloor     = opts.silenceFloor     || 3;     // deviation from 128

        this.audioCtx = null;
        this.streams  = {};          // id → stream state
        this.timer    = null;
        this._callbacks = [];
    }

    // ── lifecycle ────────────────────────────────────────────────

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this._tick(), this.analysisInterval);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    destroy() {
        this.stop();
        Object.keys(this.streams).forEach(id => this.unregisterStream(id));
        if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    }

    // ── registration ────────────────────────────────────────────

    registerHlsStream(id, videoEl, hlsInstance) {
        this._ensureAudioCtx();
        this.unregisterStream(id);   // cleanup if re-registering

        let analyser = null;
        let mediaSource = null;
        const dataArray = new Uint8Array(128);

        try {
            mediaSource = this.audioCtx.createMediaElementSource(videoEl);
            analyser = this.audioCtx.createAnalyser();
            analyser.fftSize = 256;
            mediaSource.connect(analyser);
            // Do NOT connect to destination — keep muted
        } catch (e) {
            console.warn(`[health] Could not create audio source for stream ${id}:`, e);
        }

        const state = {
            type: 'hls',
            videoEl,
            hlsInstance,
            analyser,
            mediaSource,
            dataArray,
            audioLevel: 0,
            lastTimeUpdate: Date.now(),
            lastCurrentTime: 0,
            silenceStart: null,
            alarms: new Set(),
            _onTimeUpdate: null,
            _onError: null,
            _onPlaying: null,
        };

        // timeupdate watchdog
        state._onTimeUpdate = () => {
            state.lastTimeUpdate = Date.now();
            state.lastCurrentTime = videoEl.currentTime;
            state.alarms.delete('STALLED');
            state.alarms.delete('NO SIGNAL');
        };
        videoEl.addEventListener('timeupdate', state._onTimeUpdate);

        // playing event — clear stall
        state._onPlaying = () => {
            state.alarms.delete('STALLED');
            state.alarms.delete('NO SIGNAL');
        };
        videoEl.addEventListener('playing', state._onPlaying);

        // HLS fatal error
        if (hlsInstance) {
            state._onError = (_e, data) => {
                if (data.fatal) {
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        state.alarms.add('NO SIGNAL');
                    }
                }
            };
            hlsInstance.on(Hls.Events.ERROR, state._onError);
        }

        this.streams[id] = state;
    }

    registerYoutubeStream(id, ytPlayer) {
        this.unregisterStream(id);

        const state = {
            type: 'youtube',
            ytPlayer,
            analyser: null,
            mediaSource: null,
            dataArray: null,
            audioLevel: -1,            // -1 = unavailable
            lastTimeUpdate: Date.now(),
            lastCurrentTime: 0,
            silenceStart: null,
            alarms: new Set(),
            _stateChangeHandler: null,
            _checkInterval: null,
        };

        // Poll YT player state for stall detection
        state._checkInterval = setInterval(() => {
            try {
                const ps = ytPlayer.getPlayerState();
                const ct = ytPlayer.getCurrentTime();

                if (ps === YT.PlayerState.PLAYING) {
                    if (Math.abs(ct - state.lastCurrentTime) > 0.1) {
                        state.lastTimeUpdate = Date.now();
                        state.alarms.delete('STALLED');
                        state.alarms.delete('NO SIGNAL');
                        state.alarms.delete('BUFFERING');
                    }
                    state.lastCurrentTime = ct;
                } else if (ps === YT.PlayerState.BUFFERING) {
                    state.alarms.add('BUFFERING');
                } else if (ps === -1 || ps === YT.PlayerState.ENDED) {
                    state.alarms.add('NO SIGNAL');
                    state.alarms.delete('BUFFERING');
                }
            } catch (e) { /* player not ready yet */ }
        }, 1000);

        this.streams[id] = state;
    }

    unregisterStream(id) {
        const s = this.streams[id];
        if (!s) return;

        if (s.type === 'hls') {
            if (s.videoEl && s._onTimeUpdate) s.videoEl.removeEventListener('timeupdate', s._onTimeUpdate);
            if (s.videoEl && s._onPlaying)    s.videoEl.removeEventListener('playing', s._onPlaying);
            if (s.hlsInstance && s._onError)  s.hlsInstance.off(Hls.Events.ERROR, s._onError);
            if (s.mediaSource) { try { s.mediaSource.disconnect(); } catch(e) {} }
            if (s.analyser)    { try { s.analyser.disconnect(); } catch(e) {} }
        }

        if (s.type === 'youtube' && s._checkInterval) {
            clearInterval(s._checkInterval);
        }

        delete this.streams[id];
    }

    // ── query ───────────────────────────────────────────────────

    getStatus(id) {
        const s = this.streams[id];
        if (!s) return null;
        return {
            audioLevel: s.audioLevel,
            alarms: Array.from(s.alarms),
            type: s.type,
        };
    }

    onStatusChange(cb) {
        this._callbacks.push(cb);
    }

    // ── internal ────────────────────────────────────────────────

    _ensureAudioCtx() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        // Resume on user gesture if suspended
        if (this.audioCtx.state === 'suspended') {
            const resume = () => {
                this.audioCtx.resume();
                document.removeEventListener('click', resume);
                document.removeEventListener('keydown', resume);
            };
            document.addEventListener('click', resume, { once: true });
            document.addEventListener('keydown', resume, { once: true });
        }
    }

    _tick() {
        const now = Date.now();

        for (const [id, s] of Object.entries(this.streams)) {
            const prevAlarms = new Set(s.alarms);

            // ── Audio level (HLS only) ──
            if (s.type === 'hls' && s.analyser && s.dataArray) {
                s.analyser.getByteTimeDomainData(s.dataArray);
                let peak = 0;
                for (let i = 0; i < s.dataArray.length; i++) {
                    const v = Math.abs(s.dataArray[i] - 128);
                    if (v > peak) peak = v;
                }
                s.audioLevel = peak / 128;   // 0.0 – 1.0

                // Silence detection
                if (peak <= this.silenceFloor) {
                    if (!s.silenceStart) s.silenceStart = now;
                    if (now - s.silenceStart > this.silenceThreshold) {
                        s.alarms.add('NO AUDIO');
                    }
                } else {
                    s.silenceStart = null;
                    s.alarms.delete('NO AUDIO');
                }
            }

            // ── Stall detection ──
            if (now - s.lastTimeUpdate > this.stallThreshold) {
                // Only flag stall if we had a valid stream before
                if (s.lastCurrentTime > 0 || (now - s.lastTimeUpdate > this.stallThreshold * 2)) {
                    s.alarms.add('STALLED');
                }
            }

            // ── Notify on change ──
            if (!this._setsEqual(prevAlarms, s.alarms)) {
                this._notify(id, this.getStatus(id));
            }
        }

        // Always notify for level updates (meters need continuous data)
        for (const [id, s] of Object.entries(this.streams)) {
            this._notify(id, this.getStatus(id));
        }
    }

    _notify(id, status) {
        for (const cb of this._callbacks) {
            try { cb(id, status); } catch (e) { console.error('[health] callback error:', e); }
        }
    }

    _setsEqual(a, b) {
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
    }
}
