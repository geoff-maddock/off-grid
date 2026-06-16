/**
 * Off Grid — client-side waveform peaks + duration generation.
 *
 * Runs entirely in the browser using the Web Audio API, so picking an audio
 * file in the admin auto-produces the same `{peaks, duration}` shape that
 * generate-peaks.js (the ffmpeg CLI) emits — no server compute, no ffmpeg.
 *
 * Output matches generate-peaks.js: NUM_PEAKS normalized (0–1) max values.
 *
 * Exposed as `window.OffgridPeaks`.
 */
(function () {
  const NUM_PEAKS = 800;

  // Decode at a low sample rate to bound memory on long DJ mixes. 8 kHz is far
  // more resolution than ~800 bars need, and cuts decoded PCM ~5x vs 44.1 kHz.
  const DECODE_SAMPLE_RATE = 8000;

  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  /**
   * Read a file's duration (seconds) from media metadata — cheap, no decode.
   * @param {File|Blob} file
   * @returns {Promise<number>} duration in seconds (0 if unknown)
   */
  function getAudioDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const cleanup = () => URL.revokeObjectURL(url);
      audio.addEventListener('loadedmetadata', () => {
        const d = audio.duration;
        cleanup();
        resolve(isFinite(d) && d > 0 ? d : 0);
      });
      audio.addEventListener('error', () => {
        cleanup();
        reject(new Error('Could not read audio metadata'));
      });
      audio.src = url;
    });
  }

  /**
   * Generate normalized waveform peaks (and duration) for an audio file.
   * @param {File|Blob} file
   * @param {number} numPeaks
   * @returns {Promise<{peaks: number[], duration: number}>}
   */
  async function generatePeaks(file, numPeaks = NUM_PEAKS) {
    if (!OfflineCtx) throw new Error('Web Audio API not supported in this browser');

    const arrayBuffer = await file.arrayBuffer();

    // A throwaway context whose sampleRate sets the resample target for decode.
    const ctx = new OfflineCtx(1, 1, DECODE_SAMPLE_RATE);

    // decodeAudioData resamples to the context's sampleRate. Support both the
    // promise and legacy callback signatures.
    const audioBuf = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });

    const numCh = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    if (!len) throw new Error('Decoded audio is empty');

    // Grab channel data once. Downmix (average) on the fly per sample.
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuf.getChannelData(c));

    const samplesPerPeak = Math.max(1, Math.floor(len / numPeaks));
    const peaks = new Array(numPeaks);

    for (let i = 0; i < numPeaks; i++) {
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, len);
      let max = 0;
      for (let j = start; j < end; j++) {
        let sum = 0;
        for (let c = 0; c < numCh; c++) sum += channels[c][j];
        const abs = Math.abs(sum / numCh); // float samples are already -1..1
        if (abs > max) max = abs;
      }
      peaks[i] = Math.round(max * 1000) / 1000;
    }

    return {
      peaks,
      duration: Math.round(audioBuf.duration * 100) / 100,
    };
  }

  window.OffgridPeaks = { getAudioDuration, generatePeaks, NUM_PEAKS };
})();
