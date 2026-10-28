import init, { convert, book_info } from '../vendor/boko/boko.js';
import { ensureAzw3Cover } from './cover.js';

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
      import('./comic.js')
        .then((mod) => mod.preloadArchive())
        .catch(() => {});
      return;
    }

    if (msg.type !== 'convert') return;

    await ensureReady();
    let input = new Uint8Array(msg.bytes);
    let from = msg.from;
    let fallbackInfo = null;

    if (from === 'cbz' || from === 'cbr') {
      const { comicToEpub } = await import('./comic.js');
      self.postMessage({
        type: 'progress',
        id: msg.id,
        message: `Reading ${msg.name || 'comic'}…`,
      });
      const comic = await comicToEpub(input, {
        filename: msg.name || 'Comic',
        onProgress(update) {
          self.postMessage({
            type: 'progress',
            id: msg.id,
            message: `Preparing page ${update.done} of ${update.total}…`,
          });
        },
      });
      input = comic.bytes;
      fallbackInfo = comic.info;
      from = 'epub';
      self.postMessage({
        type: 'progress',
        id: msg.id,
        message: `Converting ${msg.name || 'comic'} to AZW3…`,
      });
    }

    let info = null;
    try {
      info = parseInfo(book_info(input, from));
    } catch {
      info = null;
    }
    if (fallbackInfo) {
      const parsed = info || {};
      info = {
        ...parsed,
        title: fallbackInfo.title || parsed.title,
        authors:
          fallbackInfo.authors && fallbackInfo.authors.length
            ? fallbackInfo.authors
            : parsed.authors || [],
        language: fallbackInfo.language || parsed.language,
        pages: fallbackInfo.pages,
      };
    }

    let output = convert(input, from, 'azw3');
    output = await ensureAzw3Cover(input, from, output);
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
