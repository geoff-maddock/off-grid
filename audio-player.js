/**
 * <offgrid-player> — SoundCloud-style audio player web component
 * Uses WaveSurfer.js for waveform rendering & playback
 *
 * Attributes:
 *   src         — URL to audio file (required)
 *   title       — Track title
 *   artist      — Artist name
 *   thumb       — URL to thumbnail image
 *   color       — Waveform accent color (default: #ff5500)
 *   peaks       — URL to pre-computed peaks JSON ({peaks: number[], duration: number})
 *   duration    — Optional pre-known duration string (e.g. "3:42")
 *   description — Optional track description (shown via expandable "more" button)
 */

// URL this script was loaded from — used to generate self-contained embed code.
const OFFGRID_SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';

class OffgridPlayer extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'title', 'artist', 'thumb', 'color', 'duration', 'peaks', 'description', 'tags', 'open-tracklist'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._ws = null;
    this._ready = false;
    this._initialized = false;
    this._playOnReady = false;
    this._peaksData = null;
    this._peaksDuration = null;
    this._tracks = [];
    this._seekOnReady = null;
  }

  connectedCallback() {
    this._render();
    this._initInlineTracklist();
    this._peaksPromise = this._loadPeaksAndShow();
  }

  // Read an optional inline tracklist for static embeds:
  //   <script type="application/json" class="tracklist">[ {time, seconds, artist, title}, … ]</script>
  // If this script runs during parsing (no `defer`, or placed before the
  // element), the child <script> may not exist yet when we're upgraded — so
  // re-check once the document has finished parsing.
  _initInlineTracklist() {
    this._readInlineTracklist();
    this._renderTracklist();
    if (!this._tracks.length && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (this._readInlineTracklist()) this._renderTracklist();
      }, { once: true });
    }
  }

  // Returns true if it populated _tracks from the inline <script> (or it was
  // already set via the `tracks` property).
  _readInlineTracklist() {
    if (this._tracks.length) return true;
    const tlEl = this.querySelector('script[type="application/json"].tracklist');
    if (!tlEl) return false;
    try {
      const data = JSON.parse(tlEl.textContent);
      if (Array.isArray(data) && data.length) {
        this._tracks = data;
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  disconnectedCallback() {
    if (this._ws) {
      this._ws.destroy();
      this._ws = null;
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (!this.shadowRoot) return;
    if (name === 'src' && oldVal !== newVal && this._ws) {
      this._loadAudio();
    }
    if (['title', 'artist', 'thumb', 'description'].includes(name)) {
      this._updateMeta();
    }
    if (name === 'open-tracklist') {
      this._applyTracklistOpen();
    }
  }

  get _color() {
    return this.getAttribute('color') || '#ff5500';
  }

  // Load peaks JSON if available and render a static preview waveform
  async _loadPeaksAndShow() {
    const peaksUrl = this.getAttribute('peaks');
    if (!peaksUrl) return; // No peaks — player stays in idle placeholder state

    try {
      const label = this.shadowRoot.querySelector('#shimmer-label');
      if (label) label.textContent = '';

      const resp = await fetch(peaksUrl);
      if (!resp.ok) return;
      const data = await resp.json();
      this._peaksData = data.peaks;
      this._peaksDuration = data.duration;

      // Show duration from peaks data
      if (data.duration) {
        this.shadowRoot.querySelector('.time-total').textContent = this._fmt(data.duration);
      }

      // Draw a static canvas waveform preview
      this._drawStaticWaveform(data.peaks);
    } catch (e) {
      // Peaks failed to load — not critical, player still works on click
    }
  }

  _drawStaticWaveform(peaks) {
    const shimmer = this.shadowRoot.querySelector('#shimmer');
    if (!shimmer) return;

    // Replace shimmer with a canvas
    const canvas = document.createElement('canvas');
    const height = 64;
    const width = shimmer.offsetWidth || 680;
    canvas.width = width * 2; // retina
    canvas.height = height * 2;
    canvas.style.cssText = `width:100%;height:${height}px;border-radius:4px;display:block;`;

    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    const barWidth = 2;
    const barGap = 1;
    const step = barWidth + barGap;
    const numBars = Math.floor(width / step);
    const samplesPerBar = Math.floor(peaks.length / numBars);

    ctx.fillStyle = '#444';
    for (let i = 0; i < numBars; i++) {
      const start = i * samplesPerBar;
      let max = 0;
      for (let j = start; j < start + samplesPerBar && j < peaks.length; j++) {
        if (peaks[j] > max) max = peaks[j];
      }
      const barH = Math.max(2, max * (height - 4));
      const x = i * step;
      const y = (height - barH) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, 2);
      ctx.fill();
    }

    shimmer.style.animation = 'none';
    shimmer.innerHTML = '';
    shimmer.appendChild(canvas);
    shimmer.style.background = 'transparent';
    shimmer.style.overflow = 'hidden';
  }

  _render() {
    const thumb = this.getAttribute('thumb') || '';
    const title = this.getAttribute('title') || 'Untitled Track';
    const artist = this.getAttribute('artist') || '';

    this.shadowRoot.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :host {
          display: block;
          container-type: inline-size; /* responsive to the player's own width */
          font-family: 'IBM Plex Sans', sans-serif;
          --accent: ${this._color};
          --bg: #1a1a1a;
          --bg2: #252525;
          --bg3: #2e2e2e;
          --text: #f0f0f0;
          --text-muted: #888;
          --wave-bg: #333;
          --wave-progress: var(--accent);
          --wave-cursor: transparent;
          --radius: 4px;
        }

        .player {
          background: var(--bg);
          border: 1px solid #333;
          border-radius: 8px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          transition: border-color 0.2s;
          user-select: none;
        }

        .player:hover {
          border-color: #444;
        }

        /* TOP ROW: thumb + meta + controls */
        .top {
          display: flex;
          align-items: stretch;
          gap: 0;
        }

        .thumb-wrap {
          flex-shrink: 0;
          width: 80px;
          height: 80px;
          overflow: hidden;
          background: var(--bg3);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .thumb-wrap img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .thumb-placeholder {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #2a2a2a 0%, #333 100%);
        }

        .thumb-placeholder svg {
          width: 28px;
          height: 28px;
          opacity: 0.3;
        }

        .meta-row {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 10px 14px;
          min-width: 0;
        }

        .track-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.3;
        }

        .track-artist {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .time-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 6px;
        }

        .time-display {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          letter-spacing: 0.02em;
        }

        .time-current { color: var(--text); }

        /* Tags */
        .tag-wrap {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          padding: 6px 14px 8px;
          align-items: center;
        }

        .tag-wrap:empty {
          display: none;
        }

        .tag-pill {
          display: inline-block;
          background: rgba(255, 85, 0, 0.08);
          border: 1px solid rgba(255, 85, 0, 0.15);
          border-radius: 20px;
          padding: 1px 8px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.03em;
          color: color-mix(in srgb, var(--accent) 80%, white);
          text-transform: lowercase;
          line-height: 1.6;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
        }

        .tag-pill:hover {
          background: rgba(255, 85, 0, 0.18);
          border-color: rgba(255, 85, 0, 0.3);
        }

        .play-btn-wrap {
          display: flex;
          align-items: center;
          padding: 0 16px 0 12px;
          flex-shrink: 0;
        }

        .play-btn {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background: var(--accent);
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.1s, background 0.15s, opacity 0.15s;
          flex-shrink: 0;
          position: relative;
        }

        .play-btn:hover {
          transform: scale(1.08);
          background: color-mix(in srgb, var(--accent) 80%, white);
        }

        .play-btn:active {
          transform: scale(0.96);
        }

        .play-btn.loading {
          opacity: 0.7;
          cursor: default;
        }

        .play-icon, .pause-icon {
          display: block;
        }

        .pause-icon { display: none; }

        :host([playing]) .play-icon { display: none; }
        :host([playing]) .pause-icon { display: block; }

        /* spinner ring */
        .spinner {
          display: none;
          position: absolute;
          inset: 2px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.2);
          border-top-color: white;
          animation: spin 0.7s linear infinite;
        }

        .play-btn.loading .spinner { display: block; }
        .play-btn.loading svg { opacity: 0.4; }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* WAVEFORM ROW */
        .wave-row {
          padding: 0 14px 14px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        #waveform {
          width: 100%;
          cursor: pointer;
          border-radius: var(--radius);
          overflow: hidden;
        }

        #waveform wave {
          overflow: hidden !important;
        }

        /* volume row */
        .bottom-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 14px 10px;
        }

        .vol-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .vol-icon {
          color: var(--text-muted);
          cursor: pointer;
          display: flex;
          align-items: center;
          transition: color 0.15s;
        }

        .vol-icon:hover { color: var(--text); }

        input[type=range] {
          -webkit-appearance: none;
          appearance: none;
          width: 80px;
          height: 3px;
          background: var(--wave-bg);
          border-radius: 2px;
          outline: none;
          cursor: pointer;
        }

        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          transition: transform 0.1s;
        }

        input[type=range]::-webkit-slider-thumb:hover {
          transform: scale(1.3);
        }

        .download-btn {
          background: none;
          border: 1px solid #444;
          border-radius: var(--radius);
          color: var(--text-muted);
          font-size: 11px;
          font-family: 'IBM Plex Sans', sans-serif;
          padding: 3px 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: color 0.15s, border-color 0.15s;
          text-decoration: none;
        }

        .download-btn:hover {
          color: var(--text);
          border-color: #666;
        }

        /* More / Description */
        .more-btn {
          background: none;
          border: 1px solid #444;
          border-radius: var(--radius);
          color: var(--text-muted);
          font-size: 11px;
          font-family: 'IBM Plex Sans', sans-serif;
          padding: 3px 8px;
          cursor: pointer;
          display: none;
          align-items: center;
          gap: 4px;
          transition: color 0.15s, border-color 0.15s;
        }

        .more-btn:hover {
          color: var(--text);
          border-color: #666;
        }

        .more-btn .chevron {
          transition: transform 0.2s ease;
          display: inline-block;
        }

        .more-btn.open .chevron {
          transform: rotate(180deg);
        }

        :host([has-description]) .more-btn {
          display: inline-flex;
        }

        /* Tracklist */
        .tracklist-panel {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease;
        }
        .tracklist-panel.open {
          max-height: 320px;
          overflow-y: auto;
        }
        .tracklist-list {
          list-style: none;
          margin: 0;
          padding: 4px 14px 10px;
          font-size: 12px;
        }
        .tracklist-list .tl-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          color: var(--text);
          border-top: 1px solid #2a2a2a;
        }
        .tracklist-list .tl-item:first-child { border-top: none; }
        .tracklist-list .tl-time {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          flex-shrink: 0;
          min-width: 42px;
        }
        .tracklist-list .tl-item.seekable { cursor: pointer; }
        .tracklist-list .tl-item.seekable:hover,
        .tracklist-list .tl-item.seekable:hover .tl-time { color: var(--accent); }
        .tracklist-list .tl-label { line-height: 1.4; flex: 1; min-width: 0; }
        .tracklist-list .tl-link {
          flex-shrink: 0;
          margin-left: auto;
          color: var(--accent);
          text-decoration: none;
          font-size: 14px;
          line-height: 1;
          padding: 0 4px;
        }
        .tracklist-list .tl-link:hover { opacity: 0.75; }

        .desc-panel {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease, padding 0.3s ease;
          padding: 0 14px;
          position: relative;
        }

        .desc-panel.open {
          max-height: var(--desc-max-h, 120px);
          overflow-y: auto;
          padding: 0 14px 0;
        }

        .desc-panel.open::-webkit-scrollbar {
          width: 3px;
        }
        .desc-panel.open::-webkit-scrollbar-track { background: transparent; }
        .desc-panel.open::-webkit-scrollbar-thumb {
          background: #444;
          border-radius: 2px;
        }

        .desc-text {
          font-size: 13px;
          line-height: 1.6;
          color: var(--text-muted);
          border-top: 1px solid #2a2a2a;
          padding-top: 12px;
          padding-bottom: 8px;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .resize-handle {
          display: none;
          height: 14px;
          cursor: ns-resize;
          align-items: center;
          justify-content: center;
          user-select: none;
          touch-action: none;
          flex-shrink: 0;
        }

        .desc-panel.open ~ .resize-handle {
          display: flex;
        }

        .resize-grip {
          width: 32px;
          height: 4px;
          border-radius: 2px;
          background: #444;
          transition: background 0.15s, width 0.15s;
        }

        .resize-handle:hover .resize-grip {
          background: var(--accent);
          width: 48px;
        }

        .resize-handle.dragging .resize-grip {
          background: var(--accent);
          width: 48px;
        }

        /* Embed button & panel */
        .embed-btn {
          background: none;
          border: 1px solid #444;
          border-radius: var(--radius);
          color: var(--text-muted);
          font-size: 11px;
          font-family: 'IBM Plex Sans', sans-serif;
          padding: 3px 8px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: color 0.15s, border-color 0.15s;
        }

        .embed-btn:hover {
          color: var(--text);
          border-color: #666;
        }

        .embed-panel {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease, padding 0.3s ease;
          padding: 0 14px;
        }

        .embed-panel.open {
          max-height: 200px;
          padding: 10px 14px;
        }

        .embed-code {
          background: #111;
          border: 1px solid #333;
          border-radius: var(--radius);
          padding: 10px 12px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: #ccc;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-all;
          position: relative;
        }

        .embed-copy-btn {
          position: absolute;
          top: 6px;
          right: 6px;
          background: #333;
          border: 1px solid #555;
          border-radius: 3px;
          color: var(--text-muted);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          padding: 2px 6px;
          cursor: pointer;
          transition: color 0.15s, background 0.15s;
        }

        .embed-copy-btn:hover {
          background: #444;
          color: var(--text);
        }

        .embed-copy-btn.copied {
          color: #88dd88;
          border-color: #88dd88;
        }

        /* idle placeholder */
        .wave-placeholder {
          height: 64px;
          background: var(--bg3);
          border-radius: var(--radius);
          position: relative;
          overflow: hidden;
        }

        .placeholder-label {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          letter-spacing: 0.05em;
          z-index: 1;
          opacity: 0.6;
        }

        /* loading state shimmer */
        .wave-shimmer {
          height: 64px;
          background: var(--bg3);
          border-radius: var(--radius);
          position: relative;
          overflow: hidden;
          display: none;
        }

        .wave-shimmer::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent 25%, #3a3a3a 50%, transparent 75%);
          background-size: 200% 100%;
          animation: shimmer 1.2s infinite;
        }

        .shimmer-progress {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 3px;
          background: var(--accent);
          border-radius: 2px;
          transition: width 0.3s ease;
          width: 0%;
          z-index: 1;
        }

        .shimmer-label {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          letter-spacing: 0.05em;
          z-index: 1;
        }

        /* error state */
        .wave-error {
          height: 64px;
          background: var(--bg3);
          border-radius: var(--radius);
          display: none;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: #ff4444;
          letter-spacing: 0.02em;
        }

        .wave-error svg {
          flex-shrink: 0;
        }

        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        .more-btn .btn-icon { flex-shrink: 0; }

        /* Responsive collapse, keyed on the player's own width (works in any embed).
           Medium width: the secondary buttons (More / Embed / Download) go icon-only;
           the Tracklist button keeps its label + count. */
        @container (max-width: 520px) {
          #more-btn .btn-label,
          .embed-btn .btn-label,
          .download-btn .btn-label { display: none; }
          #more-btn, .embed-btn, .download-btn { padding: 4px 6px; gap: 4px; }
          #more-btn .chevron { display: none; }
        }

        /* Small (mobile): the Tracklist button collapses too (icon + count badge),
           and the volume slider gives way to just the mute icon. */
        @container (max-width: 400px) {
          .tracklist-btn .btn-label { display: none; }
          .tracklist-btn { padding: 4px 6px; gap: 4px; }
          .tracklist-btn .chevron { display: none; }
          .vol-wrap input[type="range"] { display: none; }
          .vol-wrap { gap: 0; }
        }
      </style>

      <div class="player" part="player">
        <div class="top">
          <div class="thumb-wrap">
            ${thumb
              ? `<img src="${thumb}" alt="thumbnail" class="thumb-img">`
              : `<div class="thumb-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12-3c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/>
                  </svg>
                </div>`}
          </div>

          <div class="meta-row">
            <div class="track-title">${title}</div>
            ${artist ? `<div class="track-artist">${artist}</div>` : ''}
            <div class="time-row">
              <span class="time-display time-current">0:00</span>
              <span class="time-display">/</span>
              <span class="time-display time-total">--:--</span>
            </div>
          </div>

          <div class="play-btn-wrap">
            <button class="play-btn" aria-label="Play">
              <div class="spinner"></div>
              <svg class="play-icon" width="16" height="16" viewBox="0 0 16 16" fill="white">
                <path d="M3 2.5l11 5.5-11 5.5z"/>
              </svg>
              <svg class="pause-icon" width="16" height="16" viewBox="0 0 16 16" fill="white">
                <rect x="3" y="2" width="4" height="12" rx="1"/>
                <rect x="9" y="2" width="4" height="12" rx="1"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="tag-wrap" id="tag-wrap"></div>

        <div class="wave-row">
          <div class="wave-placeholder" id="shimmer">
            <div class="placeholder-label" id="shimmer-label"></div>
          </div>
          <div class="wave-shimmer" id="loading-shimmer">
            <div class="shimmer-progress" id="shimmer-progress"></div>
            <div class="shimmer-label" id="loading-label">Loading\u2026</div>
          </div>
          <div class="wave-error" id="wave-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span id="error-msg">Failed to load audio</span>
          </div>
          <div id="waveform" style="display:none"></div>
        </div>

        <div class="bottom-row">
          <div class="vol-wrap">
            <span class="vol-icon" id="vol-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
              </svg>
            </span>
            <input type="range" id="volume" min="0" max="1" step="0.01" value="0.8">
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="more-btn tracklist-btn" id="tracklist-btn" style="display:none" title="Tracklist" aria-label="Tracklist">
              <svg class="btn-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M4 6h11v2H4V6zm0 5h11v2H4v-2zm0 5h11v2H4v-2zm15-9.5l4 2.5-4 2.5V6.5zm0 7l4 2.5-4 2.5v-5z"/>
              </svg>
              <span class="btn-label">Tracklist</span> <span class="tl-count"></span> <span class="chevron">&#9662;</span>
            </button>
            <button class="more-btn" id="more-btn" title="More info" aria-label="More info">
              <svg class="btn-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              <span class="btn-label">More</span> <span class="chevron">&#9662;</span>
            </button>
            <button class="embed-btn" id="embed-btn" title="Embed" aria-label="Embed">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
              </svg>
              <span class="btn-label">Embed</span>
            </button>
            <a class="download-btn" id="dl-btn" href="#" download title="Download" aria-label="Download">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
              </svg>
              <span class="btn-label">Download</span>
            </a>
          </div>
        </div>

        <div class="desc-panel" id="desc-panel">
          <div class="desc-text" id="desc-text"></div>
        </div>
        <div class="resize-handle" id="resize-handle">
          <div class="resize-grip"></div>
        </div>

        <div class="embed-panel" id="embed-panel">
          <div class="embed-code" id="embed-code"><button class="embed-copy-btn" id="embed-copy-btn">Copy</button></div>
        </div>

        <div class="tracklist-panel" id="tracklist-panel">
          <ol class="tracklist-list" id="tracklist-list"></ol>
        </div>
      </div>
    `;

    // Set description if present
    const desc = this.getAttribute('description') || '';
    if (desc) {
      this.setAttribute('has-description', '');
      this.shadowRoot.querySelector('#desc-text').textContent = desc;
    }

    // Set tags if present
    this._renderTags();

    this._bindStaticEvents();
  }

  _bindStaticEvents() {
    const playBtn = this.shadowRoot.querySelector('.play-btn');
    const volSlider = this.shadowRoot.querySelector('#volume');
    const volIcon = this.shadowRoot.querySelector('#vol-icon');

    playBtn.addEventListener('click', () => {
      if (!this._initialized) {
        this._initAndPlay();
        return;
      }
      if (!this._ready) return; // still loading
      this._ws.playPause();
    });

    volSlider.addEventListener('input', (e) => {
      if (this._ws) this._ws.setVolume(parseFloat(e.target.value));
    });

    volIcon.addEventListener('click', () => {
      if (!this._ws) return;
      const slider = this.shadowRoot.querySelector('#volume');
      if (this._ws.getVolume() > 0) {
        this._ws.setVolume(0);
        slider.value = 0;
      } else {
        const v = parseFloat(slider.dataset.last || 0.8);
        this._ws.setVolume(v);
        slider.value = v;
      }
    });

    volSlider.addEventListener('change', (e) => {
      volSlider.dataset.last = e.target.value;
    });

    // Download button
    const src = this.getAttribute('src');
    const dlBtn = this.shadowRoot.querySelector('#dl-btn');
    if (src) {
      dlBtn.href = src;
      dlBtn.setAttribute('download', src.split('/').pop() || 'track.mp3');
    }

    // More / description toggle
    const moreBtn = this.shadowRoot.querySelector('#more-btn');
    const descPanel = this.shadowRoot.querySelector('#desc-panel');
    moreBtn.addEventListener('click', () => {
      const isOpen = descPanel.classList.toggle('open');
      moreBtn.classList.toggle('open', isOpen);
      if (isOpen) {
        // Set initial max-height to fit content, capped at 120px
        const scrollH = descPanel.scrollHeight;
        descPanel.style.setProperty('--desc-max-h', Math.min(scrollH, 120) + 'px');
      }
    });

    // Resize handle drag
    const resizeHandle = this.shadowRoot.querySelector('#resize-handle');
    let startY = 0;
    let startH = 0;

    const onPointerDown = (e) => {
      if (!descPanel.classList.contains('open')) return;
      e.preventDefault();
      startY = e.clientY;
      startH = descPanel.offsetHeight;
      resizeHandle.classList.add('dragging');
      descPanel.style.transition = 'none';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    };

    const onPointerMove = (e) => {
      const delta = e.clientY - startY;
      const newH = Math.max(60, startH + delta);
      descPanel.style.setProperty('--desc-max-h', newH + 'px');
    };

    const onPointerUp = () => {
      resizeHandle.classList.remove('dragging');
      descPanel.style.transition = '';
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };

    resizeHandle.addEventListener('pointerdown', onPointerDown);

    // Embed button
    const embedBtn = this.shadowRoot.querySelector('#embed-btn');
    const embedPanel = this.shadowRoot.querySelector('#embed-panel');
    const embedCode = this.shadowRoot.querySelector('#embed-code');
    const embedCopyBtn = this.shadowRoot.querySelector('#embed-copy-btn');

    embedBtn.addEventListener('click', () => {
      const isOpen = embedPanel.classList.toggle('open');
      if (isOpen) {
        const code = this._generateEmbedCode();
        embedCode.textContent = code;
        embedCode.appendChild(embedCopyBtn);
      }
    });

    embedCopyBtn.addEventListener('click', () => {
      const code = this._generateEmbedCode();
      navigator.clipboard.writeText(code).then(() => {
        embedCopyBtn.textContent = 'Copied!';
        embedCopyBtn.classList.add('copied');
        setTimeout(() => {
          embedCopyBtn.textContent = 'Copy';
          embedCopyBtn.classList.remove('copied');
        }, 2000);
      });
    });

    // Tracklist toggle + click-to-seek
    const tlBtn = this.shadowRoot.querySelector('#tracklist-btn');
    const tlPanel = this.shadowRoot.querySelector('#tracklist-panel');
    const tlList = this.shadowRoot.querySelector('#tracklist-list');
    if (tlBtn && tlPanel) {
      tlBtn.addEventListener('click', () => {
        const isOpen = tlPanel.classList.toggle('open');
        tlBtn.classList.toggle('open', isOpen);
      });
    }
    if (tlList) {
      tlList.addEventListener('click', (e) => {
        if (e.target.closest('.tl-link')) return; // let the link open; don't seek
        const li = e.target.closest('.tl-item');
        if (!li) return;
        const t = this._tracks[parseInt(li.dataset.i, 10)];
        if (t && Number.isFinite(t.seconds)) this._seekTo(t.seconds);
      });
    }
  }

  // Called on first play click — initializes WaveSurfer and auto-plays when ready
  async _initAndPlay() {
    if (this._initialized) return;
    this._initialized = true;
    this._playOnReady = true;

    // Show loading state
    const playBtn = this.shadowRoot.querySelector('.play-btn');
    playBtn.classList.add('loading');

    // Switch from placeholder to loading shimmer
    const placeholder = this.shadowRoot.querySelector('#shimmer');
    const loadingShimmer = this.shadowRoot.querySelector('#loading-shimmer');
    if (placeholder) placeholder.style.display = 'none';
    if (loadingShimmer) loadingShimmer.style.display = 'block';

    // Wait for peaks to load (if a peaks attribute was set)
    if (this._peaksPromise) {
      await this._peaksPromise;
    }

    await this._loadWaveSurfer();
  }

  async _loadWaveSurfer() {
    // Load WaveSurfer from CDN if not already loaded
    if (!window.WaveSurfer) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/wavesurfer.js/7.8.7/wavesurfer.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    await this._initWaveSurfer();
  }

  async _initWaveSurfer() {
    const container = this.shadowRoot.querySelector('#waveform');
    const accent = this._color;
    const src = this.getAttribute('src');

    // Container must be visible for WaveSurfer to measure width
    container.style.display = 'block';

    const opts = {
      container,
      waveColor: '#444',
      progressColor: accent,
      cursorColor: 'transparent',
      cursorWidth: 0,
      height: 64,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      fillParent: true,
    };

    if (this._peaksData) {
      // With peaks: use a streaming <audio> element for instant playback,
      // then fetch the full blob in the background for reliable seeking.
      const audio = document.createElement('audio');
      audio.src = src;
      audio.preload = 'auto';
      opts.media = audio;
      opts.peaks = [this._peaksData];
      opts.duration = this._peaksDuration;
    } else {
      // Without peaks: WaveSurfer fetches + decodes the file itself
      opts.url = src;
    }

    this._ws = WaveSurfer.create(opts);

    // With peaks: fetch full blob in background so seeking works on servers
    // without Range request support (e.g. python http.server)
    if (this._peaksData) {
      this._fetchAsBlob(src).then(blobUrl => {
        if (!this._ws) return;
        const currentTime = this._ws.getCurrentTime();
        const wasPlaying = this._ws.isPlaying();
        this._ws.getMediaElement().src = blobUrl;
        this._ws.getMediaElement().currentTime = currentTime;
        if (wasPlaying) this._ws.play();
      }).catch(() => {}); // Seeking may not work on servers without Range support
    }

    this._ws.on('loading', (percent) => {
      if (this._peaksData) return;
      const bar = this.shadowRoot.querySelector('#shimmer-progress');
      const label = this.shadowRoot.querySelector('#loading-label');
      if (bar) bar.style.width = percent + '%';
      if (label) label.textContent = percent < 100 ? `Loading\u2026 ${Math.round(percent)}%` : 'Decoding\u2026';
    });

    this._ws.on('ready', () => {
      this._ready = true;
      const playBtn = this.shadowRoot.querySelector('.play-btn');
      playBtn.classList.remove('loading');

      const placeholder = this.shadowRoot.querySelector('#shimmer');
      const loadingShimmer = this.shadowRoot.querySelector('#loading-shimmer');
      if (placeholder) placeholder.style.display = 'none';
      if (loadingShimmer) loadingShimmer.style.display = 'none';

      const dur = this._ws.getDuration();
      this.shadowRoot.querySelector('.time-total').textContent = this._fmt(dur);

      if (this._seekOnReady != null) {
        this._wsSeek(this._seekOnReady);
        this._seekOnReady = null;
      }
      if (this._playOnReady) {
        this._playOnReady = false;
        this._ws.play();
      }
    });

    this._ws.on('audioprocess', (t) => {
      this.shadowRoot.querySelector('.time-current').textContent = this._fmt(t);
    });

    this._ws.on('seeking', (t) => {
      this.shadowRoot.querySelector('.time-current').textContent = this._fmt(t);
    });

    this._ws.on('play', () => {
      this.setAttribute('playing', '');
      this.dispatchEvent(new CustomEvent('trackplay', { bubbles: true, composed: true, detail: { src: this.getAttribute('src') } }));
    });

    this._ws.on('pause', () => {
      this.removeAttribute('playing');
      this.dispatchEvent(new CustomEvent('trackpause', { bubbles: true, composed: true }));
    });

    this._ws.on('finish', () => {
      this.removeAttribute('playing');
      this.shadowRoot.querySelector('.time-current').textContent = this._fmt(0);
      this.dispatchEvent(new CustomEvent('trackfinish', { bubbles: true, composed: true }));
    });

    this._ws.on('error', (e) => {
      console.warn('WaveSurfer error:', e);
      const playBtn = this.shadowRoot.querySelector('.play-btn');
      playBtn.classList.remove('loading');
      playBtn.disabled = true;
      playBtn.style.opacity = '0.3';
      playBtn.style.cursor = 'default';

      const placeholder = this.shadowRoot.querySelector('#shimmer');
      const loadingShimmer = this.shadowRoot.querySelector('#loading-shimmer');
      const waveDiv = this.shadowRoot.querySelector('#waveform');
      const errorEl = this.shadowRoot.querySelector('#wave-error');
      if (placeholder) placeholder.style.display = 'none';
      if (loadingShimmer) loadingShimmer.style.display = 'none';
      if (waveDiv) waveDiv.style.display = 'none';
      if (errorEl) errorEl.style.display = 'flex';
    });

    this._ws.setVolume(0.8);
  }

  async _fetchAsBlob(url) {
    const bar = this.shadowRoot.querySelector('#shimmer-progress');
    const label = this.shadowRoot.querySelector('#loading-label');

    const response = await fetch(url);
    const total = parseInt(response.headers.get('content-length') || '0', 10);

    if (!total || !response.body) {
      // No content-length or no streaming — fall back to simple fetch
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      const pct = Math.round((loaded / total) * 100);
      if (bar) bar.style.width = pct + '%';
      if (label) label.textContent = `Loading\u2026 ${pct}%`;
    }

    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'audio/mpeg' });
    return URL.createObjectURL(blob);
  }

  _loadAudio() {
    const src = this.getAttribute('src');
    if (!src || !this._ws) return;
    this._ready = false;
    const playBtn = this.shadowRoot.querySelector('.play-btn');
    if (playBtn) playBtn.classList.add('loading');

    // Update download link
    const dlBtn = this.shadowRoot.querySelector('#dl-btn');
    if (dlBtn) {
      dlBtn.href = src;
      dlBtn.setAttribute('download', src.split('/').pop() || 'track.mp3');
    }

    this._ws.load(src);
  }

  _updateMeta() {
    if (!this.shadowRoot) return;
    const title = this.getAttribute('title') || 'Untitled Track';
    const artist = this.getAttribute('artist') || '';
    const thumb = this.getAttribute('thumb') || '';

    const titleEl = this.shadowRoot.querySelector('.track-title');
    const artistEl = this.shadowRoot.querySelector('.track-artist');
    const thumbWrap = this.shadowRoot.querySelector('.thumb-wrap');

    if (titleEl) titleEl.textContent = title;
    if (artistEl) {
      if (artist) {
        artistEl.textContent = artist;
        artistEl.style.display = '';
      } else {
        artistEl.style.display = 'none';
      }
    }
    if (thumbWrap && thumb) {
      thumbWrap.innerHTML = `<img src="${thumb}" alt="thumbnail" class="thumb-img">`;
    }

    const desc = this.getAttribute('description') || '';
    const descText = this.shadowRoot.querySelector('#desc-text');
    if (descText) descText.textContent = desc;
    if (desc) {
      this.setAttribute('has-description', '');
    } else {
      this.removeAttribute('has-description');
    }

    this._renderTags();
  }

  _renderTags() {
    const tagWrap = this.shadowRoot.querySelector('#tag-wrap');
    if (!tagWrap) return;

    const tagsAttr = this.getAttribute('tags') || '';
    let tags = [];
    try {
      tags = JSON.parse(tagsAttr);
    } catch {
      tags = tagsAttr ? tagsAttr.split(',').map(t => t.trim()).filter(Boolean) : [];
    }

    tagWrap.innerHTML = tags.map(t =>
      `<span class="tag-pill">${t}</span>`
    ).join('');

    tagWrap.querySelectorAll('.tag-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('tagclick', {
          bubbles: true, composed: true,
          detail: { tag: pill.textContent }
        }));
      });
    });
  }

  _generateEmbedCode() {
    // Every attribute the player understands, so the embed is self-contained.
    const attrNames = ['src', 'title', 'artist', 'thumb', 'peaks', 'color', 'duration', 'description', 'tags'];
    let attrs = '';
    for (const name of attrNames) {
      const value = this.getAttribute(name);
      if (value) attrs += `\n  ${name}="${this._esc(value)}"`;
    }
    // Boolean attributes carry no value — emit the bare name when present so the
    // embed reproduces the source player (e.g. a tracklist opened via ?tracklist=open).
    if (this.hasAttribute('open-tracklist')) attrs += `\n  open-tracklist`;

    // Tracklist arrives as a JS property, so serialize it as an inline JSON
    // child — connectedCallback reads <script type="application/json" class="tracklist">.
    let children = '\n';
    if (this._tracks && this._tracks.length) {
      // Escape "<" so a track title containing "</script>" can't terminate the
      // block early. "<" is valid JSON and parses back to "<".
      const json = JSON.stringify(this._tracks).replace(/</g, '\\u003c');
      children = `\n  <script type="application/json" class="tracklist">${json}<\/script>\n`;
    }

    const scriptSrc = OFFGRID_SCRIPT_SRC || 'https://your-domain.com/audio-player.js';
    return `<script src="${scriptSrc}"><\/script>\n\n<offgrid-player${attrs}>${children}</offgrid-player>`;
  }

  // Public API
  play() {
    if (this._ready && this._ws) {
      this._ws.play();
    } else if (!this._initialized) {
      this._initAndPlay();
    }
    // If initialized but not ready, it will auto-play via _playOnReady
  }
  pause() { if (this._ws) this._ws.pause(); }
  stop() { if (this._ws) { this._ws.stop(); this.removeAttribute('playing'); } }
  isPlaying() { return this._ws ? this._ws.isPlaying() : false; }

  // Tracklist: array of { time?, seconds?, artist?, title? }
  set tracks(arr) {
    this._tracks = Array.isArray(arr) ? arr : [];
    this._renderTracklist();
  }
  get tracks() { return this._tracks; }

  _renderTracklist() {
    if (!this.shadowRoot) return;
    const btn = this.shadowRoot.getElementById('tracklist-btn');
    const list = this.shadowRoot.getElementById('tracklist-list');
    if (!btn || !list) return;

    const tracks = this._tracks || [];
    if (!tracks.length) {
      btn.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    btn.style.display = 'inline-flex';
    const count = btn.querySelector('.tl-count');
    if (count) count.textContent = `(${tracks.length})`;
    // Keep the button labeled when collapsed to icon-only.
    btn.setAttribute('aria-label', `Tracklist (${tracks.length} tracks)`);
    btn.setAttribute('title', `Tracklist (${tracks.length})`);

    list.innerHTML = tracks.map((t, i) => {
      const seekable = Number.isFinite(t.seconds);
      const time = t.time || (seekable ? this._fmt(t.seconds) : '');
      // Label is plain text so clicking the row seeks. Any link is a separate
      // trailing element. Only link http(s) URLs — never javascript:/data: etc.
      const label = [t.artist, t.title].filter(Boolean).map((s) => this._esc(s)).join(' &ndash; ') || '<em>untitled</em>';
      const safeUrl = /^https?:\/\//i.test(t.url || '') ? t.url : '';
      const linkHtml = safeUrl
        ? `<a class="tl-link" href="${this._esc(safeUrl)}" target="_blank" rel="noopener" title="Open link" aria-label="Open external link">&#8599;</a>`
        : '';
      return `<li class="tl-item${seekable ? ' seekable' : ''}" data-i="${i}">` +
        `<span class="tl-time">${this._esc(time) || '&middot;'}</span>` +
        `<span class="tl-label">${label}</span>${linkHtml}</li>`;
    }).join('');

    this._applyTracklistOpen();
  }

  // Open the tracklist panel by default when the `open-tracklist` attribute is
  // present and there are tracks to show. Does not force-close otherwise, so a
  // user's manual toggle is preserved.
  _applyTracklistOpen() {
    if (!this.shadowRoot || !this.hasAttribute('open-tracklist')) return;
    if (!(this._tracks || []).length) return;
    const panel = this.shadowRoot.getElementById('tracklist-panel');
    const btn = this.shadowRoot.getElementById('tracklist-btn');
    if (panel) panel.classList.add('open');
    if (btn) btn.classList.add('open');
  }

  // Seek to a position (seconds), initializing/playing the audio if needed.
  _seekTo(seconds) {
    if (this._ready && this._ws) {
      this._wsSeek(seconds);
      if (!this._ws.isPlaying()) this._ws.play();
      return;
    }
    this._seekOnReady = seconds;
    if (!this._initialized) this._initAndPlay();
  }

  _wsSeek(seconds) {
    if (!this._ws) return;
    if (typeof this._ws.setTime === 'function') {
      this._ws.setTime(seconds);
    } else {
      const dur = this._ws.getDuration() || this._peaksDuration || 0;
      if (dur > 0) this._ws.seekTo(Math.min(1, Math.max(0, seconds / dur)));
    }
  }

  _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _fmt(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
}

customElements.define('offgrid-player', OffgridPlayer);


/**
 * <offgrid-playlist> — Playlist variant
 *
 * Attributes:
 *   color      — accent color
 *   artist     — default artist name for all tracks
 *
 * Children: JSON in a <script type="application/json"> tag OR
 * pass tracks via the `tracks` property (array of {src, title, artist, thumb, peaks})
 *
 * Example:
 * <offgrid-playlist color="#ff5500">
 *   <script type="application/json">
 *     [
 *       {"src": "track1.mp3", "title": "Track 1", "artist": "DJ X", "peaks": "track1.peaks.json"},
 *       {"src": "track2.mp3", "title": "Track 2"}
 *     ]
 *   </script>
 * </offgrid-playlist>
 */
class OffgridPlaylist extends HTMLElement {
  static get observedAttributes() {
    return ['color', 'artist'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._tracks = [];
    this._current = 0;
    this._playerEl = null;
  }

  connectedCallback() {
    // Parse inline JSON tracks
    const jsonEl = this.querySelector('script[type="application/json"]');
    if (jsonEl) {
      try { this._tracks = JSON.parse(jsonEl.textContent); } catch(e) {}
    }
    this._render();
  }

  set tracks(arr) {
    this._tracks = arr;
    this._render();
  }

  get tracks() { return this._tracks; }

  get _color() { return this.getAttribute('color') || '#ff5500'; }

  _render() {
    const color = this._color;
    const tracks = this._tracks;

    this.shadowRoot.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :host {
          display: block;
          font-family: 'IBM Plex Sans', sans-serif;
          --accent: ${color};
          --bg: #1a1a1a;
          --bg2: #222;
          --bg3: #2e2e2e;
          --bg-hover: #2a2a2a;
          --text: #f0f0f0;
          --text-muted: #888;
          --border: #333;
          --radius: 4px;
        }

        .playlist-wrap {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
        }

        /* Embedded player slot */
        .player-slot {
          border-bottom: 1px solid var(--border);
        }

        /* Track list */
        .track-list {
          list-style: none;
          overflow-y: auto;
          max-height: 320px;
        }

        .track-list::-webkit-scrollbar {
          width: 4px;
        }
        .track-list::-webkit-scrollbar-track { background: transparent; }
        .track-list::-webkit-scrollbar-thumb {
          background: #444;
          border-radius: 2px;
        }

        .track-item {
          display: flex;
          align-items: center;
          gap: 0;
          cursor: pointer;
          transition: background 0.15s;
          border-bottom: 1px solid #2a2a2a;
          position: relative;
        }

        .track-item:last-child { border-bottom: none; }

        .track-item:hover {
          background: var(--bg-hover);
        }

        .track-item.active {
          background: #222;
        }

        .track-num {
          width: 42px;
          text-align: center;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          flex-shrink: 0;
          padding: 14px 0;
          position: relative;
        }

        .track-item.active .track-num {
          color: var(--accent);
        }

        /* animated bars for currently playing */
        .bars {
          display: none;
          align-items: flex-end;
          gap: 2px;
          height: 14px;
        }

        .track-item.active.playing .bars { display: flex; }
        .track-item.active.playing .num-label { display: none; }

        .bar {
          width: 3px;
          background: var(--accent);
          border-radius: 1px;
          animation: bounce var(--dur, 0.6s) ease-in-out infinite alternate;
        }
        .bar:nth-child(1) { --dur: 0.5s; height: 6px; }
        .bar:nth-child(2) { --dur: 0.7s; height: 10px; }
        .bar:nth-child(3) { --dur: 0.4s; height: 8px; }

        @keyframes bounce {
          from { transform: scaleY(0.4); }
          to { transform: scaleY(1); }
        }

        .track-thumb {
          width: 44px;
          height: 44px;
          object-fit: cover;
          flex-shrink: 0;
          background: var(--bg3);
          display: block;
        }

        .thumb-ph {
          width: 44px;
          height: 44px;
          background: var(--bg3);
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .thumb-ph svg {
          width: 18px;
          height: 18px;
          opacity: 0.25;
          color: var(--text);
          fill: currentColor;
        }

        .track-info {
          flex: 1;
          padding: 10px 14px;
          min-width: 0;
        }

        .track-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.3;
        }

        .track-item.active .track-name {
          color: var(--accent);
        }

        .track-sub {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* next/prev hint */
        .track-arrow {
          width: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          opacity: 0;
          transition: opacity 0.15s;
          flex-shrink: 0;
        }

        .track-item:hover .track-arrow { opacity: 1; }
        .track-item.active .track-arrow { opacity: 0.5; }

        /* playlist footer */
        .pl-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          border-top: 1px solid var(--border);
          background: var(--bg2);
        }

        .pl-count {
          font-size: 11px;
          color: var(--text-muted);
          font-family: 'IBM Plex Mono', monospace;
        }

        .pl-nav {
          display: flex;
          gap: 8px;
        }

        .nav-btn {
          background: none;
          border: 1px solid #444;
          border-radius: var(--radius);
          color: var(--text-muted);
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: color 0.15s, border-color 0.15s;
        }

        .nav-btn:hover {
          color: var(--text);
          border-color: #666;
        }

        .nav-btn:disabled {
          opacity: 0.3;
          cursor: default;
        }

        /* autoplay toggle */
        .autoplay-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--text-muted);
          cursor: pointer;
          transition: color 0.15s;
        }

        .autoplay-toggle:hover { color: var(--text); }

        .toggle-pip {
          width: 28px;
          height: 16px;
          border-radius: 8px;
          background: #444;
          position: relative;
          transition: background 0.2s;
        }

        .toggle-pip::after {
          content: '';
          position: absolute;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: white;
          top: 2px;
          left: 2px;
          transition: transform 0.2s;
        }

        .autoplay-toggle.on .toggle-pip {
          background: var(--accent);
        }

        .autoplay-toggle.on .toggle-pip::after {
          transform: translateX(12px);
        }
      </style>

      <div class="playlist-wrap" part="playlist">
        <div class="player-slot" id="player-slot"></div>

        <ul class="track-list" id="track-list">
          ${tracks.map((t, i) => `
            <li class="track-item${i === 0 ? ' active' : ''}" data-index="${i}">
              <div class="track-num">
                <span class="num-label">${i + 1}</span>
                <div class="bars">
                  <div class="bar"></div>
                  <div class="bar"></div>
                  <div class="bar"></div>
                </div>
              </div>
              ${t.thumb
                ? `<img class="track-thumb" src="${t.thumb}" alt="">`
                : `<div class="thumb-ph"><svg viewBox="0 0 24 24"><path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12-3c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/></svg></div>`}
              <div class="track-info">
                <div class="track-name">${t.title || t.src.split('/').pop()}</div>
                ${t.artist || this.getAttribute('artist')
                  ? `<div class="track-sub">${t.artist || this.getAttribute('artist')}</div>` : ''}
              </div>
              <div class="track-arrow">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
            </li>
          `).join('')}
        </ul>

        <div class="pl-footer">
          <div class="pl-count">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</div>
          <div class="autoplay-toggle on" id="autoplay-toggle" title="Autoplay next track">
            <div class="toggle-pip"></div>
            <span>autoplay</span>
          </div>
          <div class="pl-nav">
            <button class="nav-btn" id="prev-btn" title="Previous" disabled>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
              </svg>
            </button>
            <button class="nav-btn" id="next-btn" title="Next" ${tracks.length <= 1 ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    this._mountPlayer(0);
    this._bindListEvents();
  }

  _mountPlayer(index) {
    const slot = this.shadowRoot.querySelector('#player-slot');
    const t = this._tracks[index];
    if (!t) return;

    // Create the inner player
    const player = document.createElement('offgrid-player');
    player.setAttribute('src', t.src);
    player.setAttribute('title', t.title || t.src.split('/').pop());
    if (t.artist || this.getAttribute('artist'))
      player.setAttribute('artist', t.artist || this.getAttribute('artist'));
    if (t.thumb) player.setAttribute('thumb', t.thumb);
    if (t.peaks) player.setAttribute('peaks', t.peaks);
    player.setAttribute('color', this._color);

    // Style override for embedding
    player.style.cssText = 'display:block;';

    slot.innerHTML = '';
    slot.appendChild(player);
    this._playerEl = player;
    this._current = index;

    player.addEventListener('trackfinish', () => {
      const autoplay = this.shadowRoot.querySelector('#autoplay-toggle');
      if (autoplay && autoplay.classList.contains('on')) {
        this._advance(1);
      }
    });

    this._updateListActive(index, false);
    this._updateNavButtons();
  }

  _bindListEvents() {
    const list = this.shadowRoot.querySelector('#track-list');
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.track-item');
      if (!item) return;
      const idx = parseInt(item.dataset.index, 10);
      if (idx === this._current) {
        // Toggle play/pause on current
        if (this._playerEl) {
          if (this._playerEl.isPlaying()) this._playerEl.pause();
          else this._playerEl.play();
        }
      } else {
        this._mountPlayer(idx);
        this._playerEl.play();
      }
    });

    this.shadowRoot.querySelector('#prev-btn').addEventListener('click', () => this._advance(-1));
    this.shadowRoot.querySelector('#next-btn').addEventListener('click', () => this._advance(1));

    const autoToggle = this.shadowRoot.querySelector('#autoplay-toggle');
    autoToggle.addEventListener('click', () => {
      autoToggle.classList.toggle('on');
    });

    // Listen for play/pause to update bars
    this.shadowRoot.querySelector('#player-slot').addEventListener('trackplay', () => {
      this._updateListActive(this._current, true);
    });
    this.shadowRoot.querySelector('#player-slot').addEventListener('trackpause', () => {
      this._updateListActive(this._current, false);
    });
  }

  _advance(dir) {
    const next = this._current + dir;
    if (next < 0 || next >= this._tracks.length) return;
    this._mountPlayer(next);
    this._playerEl.play();
  }

  _updateListActive(index, playing) {
    const items = this.shadowRoot.querySelectorAll('.track-item');
    items.forEach((item, i) => {
      item.classList.toggle('active', i === index);
      item.classList.toggle('playing', i === index && playing);
    });
  }

  _updateNavButtons() {
    const prev = this.shadowRoot.querySelector('#prev-btn');
    const next = this.shadowRoot.querySelector('#next-btn');
    if (prev) prev.disabled = this._current === 0;
    if (next) next.disabled = this._current === this._tracks.length - 1;
  }
}

customElements.define('offgrid-playlist', OffgridPlaylist);
