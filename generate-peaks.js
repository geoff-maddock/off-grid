#!/usr/bin/env node
/**
 * Generate waveform peak data from MP3 files using ffmpeg.
 *
 * Usage:
 *   node generate-peaks.js <file.mp3> [num_peaks]
 *   node generate-peaks.js --all [num_peaks]
 *
 * Outputs: <file>.peaks.json with {peaks: Float[], duration: number}
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NUM_PEAKS = parseInt(process.argv[3] || '800', 10);

function generatePeaks(mp3Path) {
  const basename = path.basename(mp3Path, path.extname(mp3Path));
  const dir = path.dirname(mp3Path);
  const outPath = path.join(dir, `${basename}.peaks.json`);
  const tmpPcm = path.join(os.tmpdir(), `${basename}_peaks.raw`);

  try {
    // Get duration
    const durationStr = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`,
      { encoding: 'utf-8' }
    ).trim();
    const duration = parseFloat(durationStr);

    // Downsample to 8kHz mono to keep the temp file small (~16KB/s instead of ~88KB/s)
    execSync(
      `ffmpeg -v quiet -y -i "${mp3Path}" -ac 1 -ar 8000 -f s16le -acodec pcm_s16le "${tmpPcm}"`,
      { stdio: 'pipe' }
    );

    // Read raw PCM from temp file
    const raw = fs.readFileSync(tmpPcm);
    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    const totalSamples = samples.length;
    const samplesPerPeak = Math.floor(totalSamples / NUM_PEAKS);

    // Compute peaks (normalized 0 to 1)
    const peaks = [];
    for (let i = 0; i < NUM_PEAKS; i++) {
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, totalSamples);
      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(samples[j]);
        if (abs > max) max = abs;
      }
      peaks.push(Math.round((max / 32768) * 1000) / 1000);
    }

    const result = { peaks, duration: Math.round(duration * 100) / 100 };
    fs.writeFileSync(outPath, JSON.stringify(result));
    console.log(`  ${basename}.peaks.json (${peaks.length} peaks, ${duration.toFixed(1)}s)`);
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPcm); } catch (_) {}
  }
}

// Main
const arg = process.argv[2];
if (!arg) {
  console.log('Usage: node generate-peaks.js <file.mp3> | --all');
  process.exit(1);
}

if (arg === '--all') {
  const dir = __dirname;
  const mp3s = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
  console.log(`Generating peaks for ${mp3s.length} files...`);
  for (const mp3 of mp3s) {
    generatePeaks(path.join(dir, mp3));
  }
  console.log('Done.');
} else {
  generatePeaks(arg);
}
