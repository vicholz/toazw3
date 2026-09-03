import init, { convert, book_info } from '../vendor/boko/boko.js';

let ready = false;

async function ensureReady() {
  if (ready) return;
  await init();
  ready = true;
}

function parseInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      await ensureReady();
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type !== 'convert') return;

    await ensureReady();
    const input = new Uint8Array(msg.bytes);
    let info = null;
    try {
      info = parseInfo(book_info(input, msg.from));
    } catch {
      info = null;
    }

    const output = convert(input, msg.from, 'azw3');
    const copy = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    self.postMessage(
      { type: 'done', id: msg.id, bytes: copy, info },
      [copy],
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
};
