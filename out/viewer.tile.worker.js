/* eslint-disable no-restricted-globals */
'use strict';

async function inflateGzip(gzBuf) {
  if (!('DecompressionStream' in self)) {
    throw new Error('DecompressionStream not available in worker');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Response(gzBuf).body.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function decodeTile(buf) {
  const count = Math.floor(buf.byteLength / 10);
  const biome = new Uint16Array(count);
  const height = new Float32Array(count);
  const forest = new Float32Array(count);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < count; i++) {
    const off = i * 10;
    biome[i] = view.getUint16(off, true);
    height[i] = view.getFloat32(off + 2, true);
    forest[i] = view.getFloat32(off + 6, true);
  }
  return { biome, height, forest, count };
}

self.onmessage = async (ev) => {
  const data = ev.data || {};
  const key = data.key;
  const gzBytes = data.gzBytes;
  if (!key || !gzBytes) {
    self.postMessage({ key, error: 'invalid payload' });
    return;
  }
  const t0 = performance.now();
  try {
    const raw = await inflateGzip(gzBytes);
    const decoded = decodeTile(raw);
    const decodeMs = Math.round(performance.now() - t0);
    self.postMessage(
      {
        key,
        biomeBuf: decoded.biome.buffer,
        heightBuf: decoded.height.buffer,
        forestBuf: decoded.forest.buffer,
        count: decoded.count,
        decodeMs,
      },
      [decoded.biome.buffer, decoded.height.buffer, decoded.forest.buffer]
    );
  } catch (e) {
    self.postMessage({ key, error: e?.message || 'decode failed' });
  }
};
