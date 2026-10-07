'use strict';
/* Кодирование mp3 в отдельном потоке: интерфейс не подвисает,
   а браузер не замедляет работу, когда вкладка уходит в фон. */

importScripts('vendor/lame.min.js');

function encode(d) {
  const enc = new lamejs.Mp3Encoder(d.channels, d.sampleRate, d.kbps);
  const left = d.left, right = d.right, len = left.length;
  const BLOCK = 1152 * 50;
  const parts = [];
  let lastSent = 0;
  for (let i = 0; i < len; i += BLOCK) {
    const n = Math.min(BLOCK, len - i);
    const chunk = d.channels === 2
      ? enc.encodeBuffer(left.subarray(i, i + n), right.subarray(i, i + n))
      : enc.encodeBuffer(left.subarray(i, i + n));
    if (chunk.length) parts.push(new Int8Array(chunk));
    const p = i / len;
    if (p - lastSent > 0.01) { lastSent = p; postMessage({ progress: p }); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Int8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.warmup) {                       // прогрев JIT, чтобы первый экспорт не тормозил
    try {
      const enc = new lamejs.Mp3Encoder(2, 44100, 128);
      const z = new Int16Array(1152);
      for (let i = 0; i < 20; i++) enc.encodeBuffer(z, z);
      enc.flush();
    } catch (err) { /* не критично */ }
    postMessage({ warm: true });
    return;
  }
  try {
    postMessage({ done: true, blob: encode(d) });
  } catch (err) {
    postMessage({ error: String((err && err.message) || err) });
  }
};
