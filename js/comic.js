import { extractArchive, preloadArchive } from './archive.js';
import { buildZipBytes } from './zip.js';

const MAX_PAGES = 2000;
const MAX_EDGE = 2560;
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);

const encoder = new TextEncoder();

export { preloadArchive };

function utf8(text) {
  return encoder.encode(text);
}

function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => fromCode(Number(num)))
    .replace(/&amp;/g, '&');
}

function fromCode(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  return String.fromCodePoint(n);
}

function baseName(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function isHiddenPath(path) {
  return path.split('/').filter(Boolean).some((part) => part.startsWith('.') || part === '__MACOSX');
}

function isComicInfo(path) {
  return baseName(path).toLowerCase() === 'comicinfo.xml';
}

function extensionKind(path) {
  const base = baseName(path).toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (IMAGE_EXT.has(ext)) return ext;
  return '';
}

function wantArchiveEntry(path) {
  if (!path || isHiddenPath(path)) return false;
  if (isComicInfo(path)) return true;
  const base = baseName(path).toLowerCase();
  if (base === 'thumbs.db' || base === 'desktop.ini') return false;
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (!ext) return true;
  return IMAGE_EXT.has(ext);
}

function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.includes('ftypavif') || head.includes('ftypavis')) return 'avif';
  return null;
}

function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0x00 || marker === 0xff || marker === 0xd8) {
      i += 1;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      return w && h ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function imageSize(bytes, kind) {
  if (kind === 'png' && bytes.length >= 24 && readU32(bytes, 12) === 0x49484452) {
    const w = readU32(bytes, 16);
    const h = readU32(bytes, 20);
    return w && h ? { w, h } : null;
  }
  if (kind === 'gif' && bytes.length >= 10) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return w && h ? { w, h } : null;
  }
  if (kind === 'jpeg') return jpegSize(bytes);
  return null;
}

async function transcodeToJpeg(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('This browser cannot re-encode WebP, BMP, or AVIF comic pages.');
  }
  const blob = new Blob([bytes]);
  let bitmap = await createImageBitmap(blob);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    if (!width || !height) throw new Error('Unreadable comic page.');
    if (Math.max(width, height) > MAX_EDGE) {
      const scale = MAX_EDGE / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const resized = await createImageBitmap(bitmap, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = resized;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare a comic page.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function prepareImage(bytes, path) {
  const sniffed = sniffImage(bytes);
  const kind = sniffed || extensionKind(path);
  if (!kind) return null;
  const native = kind === 'jpeg' || kind === 'png' || kind === 'gif';
  if (native && sniffed) {
    const size = imageSize(bytes, kind);
    if (!size || Math.max(size.w, size.h) <= MAX_EDGE) return { bytes, kind };
  }
  return { bytes: await transcodeToJpeg(bytes), kind: 'jpeg' };
}

function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return decodeXml(match[1]).replace(/\s+/g, ' ').trim();
}

function addPeople(list, seen, value) {
  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
}

function parseComicInfo(bytes) {
  const xml = decodeText(bytes);
  const meta = {
    title: tagText(xml, 'Title'),
    series: tagText(xml, 'Series'),
    number: tagText(xml, 'Number'),
    summary: tagText(xml, 'Summary'),
    language: tagText(xml, 'LanguageISO') || tagText(xml, 'Language'),
    authors: [],
  };
  const authors = [];
  const seen = new Set();
  for (const tag of ['Writer', 'Penciller', 'Inker', 'Colorist', 'Letterer']) {
    addPeople(authors, seen, tagText(xml, tag));
  }
  meta.authors = authors;
  return meta;
}

function cleanLanguage(value) {
  const match = String(value || '')
    .trim()
    .toLowerCase()
    .match(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?/);
  return match ? match[0] : 'en';
}

function titleFromFilename(name) {
  const base = String(name || '')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return base || 'Comic';
}

function comicTitle(meta, fallback) {
  const series = meta.series;
  const number = meta.number ? meta.number.replace(/^#/, '') : '';
  const title = meta.title;
  if (series && number) {
    const issue = `${series} #${number}`;
    if (title && title.toLowerCase() !== series.toLowerCase()) return `${issue}: ${title}`;
    return issue;
  }
  return title || series || fallback;
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function pad(n) {
  return String(n).padStart(4, '0');
}

function epubModified(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif' };
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

function buildEpub(pages, meta) {
  const id = crypto.randomUUID();
  const language = cleanLanguage(meta.language);
  const title = comicTitle(meta, meta.fallbackTitle);
  const modified = epubModified();
  const files = [
    { name: 'mimetype', data: utf8('application/epub+zip'), utf8: false },
    {
      name: 'META-INF/container.xml',
      data: utf8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
    },
  ];

  const manifest = [
    '    <item id="style" href="styles.css" media-type="text/css"/>',
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ];
  const spine = [];
  const navItems = [];
  const ncxPoints = [];

  pages.forEach((page, index) => {
    const n = index + 1;
    const ext = EXT[page.kind];
    const imageName = `images/p${pad(n)}.${ext}`;
    const pageName = `page${pad(n)}.xhtml`;
    const imageId = `img-${pad(n)}`;
    const pageId = `page-${pad(n)}`;
    const label = n === 1 ? 'Cover' : `Page ${n}`;
    const coverProps = n === 1 ? ' properties="cover-image"' : '';
    manifest.push(
      `    <item id="${imageId}" href="${imageName}" media-type="${MIME[page.kind]}"${coverProps}/>`,
      `    <item id="${pageId}" href="${pageName}" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`    <itemref idref="${pageId}"/>`);
    navItems.push(`      <li><a href="${pageName}">${xmlEscape(label)}</a></li>`);
    ncxPoints.push(`    <navPoint id="nav${n}" playOrder="${n}">
      <navLabel><text>${xmlEscape(label)}</text></navLabel>
      <content src="${pageName}"/>
    </navPoint>`);
    files.push({
      name: `OEBPS/${pageName}`,
      data: utf8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xmlEscape(language)}">
<head>
  <title>${xmlEscape(label)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <img alt="${xmlEscape(label)}" src="${imageName}"/>
</body>
</html>
`),
    });
    files.push({ name: `OEBPS/${imageName}`, data: page.bytes });
  });

  const creators = (meta.authors || [])
    .map((author) => `    <dc:creator>${xmlEscape(author)}</dc:creator>`)
    .join('\n');
  const description = meta.summary
    ? `    <dc:description>${xmlEscape(meta.summary.slice(0, 4000))}</dc:description>\n`
    : '';

  files.push({
    name: 'OEBPS/styles.css',
    data: utf8(`html, body { margin: 0; padding: 0; }
body { text-align: center; }
img { max-width: 100%; height: auto; }
`),
  });
  files.push({
    name: 'OEBPS/nav.xhtml',
    data: utf8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlEscape(language)}">
<head><title>${xmlEscape(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
${navItems.join('\n')}
    </ol>
  </nav>
</body>
</html>
`),
  });
  files.push({
    name: 'OEBPS/toc.ncx',
    data: utf8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${id}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(title)}</text></docTitle>
  <navMap>
${ncxPoints.join('\n')}
  </navMap>
</ncx>
`),
  });
  files.push({
    name: 'OEBPS/content.opf',
    data: utf8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${id}</dc:identifier>
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:language>${xmlEscape(language)}</dc:language>
${creators ? `${creators}\n` : ''}${description}    <meta property="dcterms:modified">${modified}</meta>
    <meta name="cover" content="img-0001"/>
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.join('\n')}
  </spine>
  <guide>
    <reference type="cover" title="Cover" href="page0001.xhtml"/>
    <reference type="text" title="Start" href="page0001.xhtml"/>
  </guide>
</package>
`),
  });

  return {
    bytes: buildZipBytes(files),
    info: {
      title,
      authors: meta.authors || [],
      language,
      pages: pages.length,
    },
  };
}

/**
 * Turn a CBZ or CBR archive into an EPUB with one image per spine item.
 * @param {Uint8Array} bytes
 * @param {{filename?: string, onProgress?: (update: {done: number, total: number}) => void}} [options]
 */
export async function comicToEpub(bytes, options = {}) {
  let entries;
  try {
    entries = await extractArchive(bytes, wantArchiveEntry);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/encrypt|password|passphrase/i.test(message)) {
      throw new Error('This comic archive is encrypted. Password-protected CBZ and CBR files are not supported.');
    }
    if (/unrecognized archive|format not|damaged archive|truncated/i.test(message)) {
      throw new Error('Could not read this comic archive. Use a CBZ (ZIP) or CBR (RAR) file.');
    }
    throw err instanceof Error ? err : new Error(message);
  }

  let meta = { title: '', series: '', number: '', summary: '', language: '', authors: [] };
  const images = [];
  for (const entry of entries) {
    if (isComicInfo(entry.path)) {
      try {
        const parsed = parseComicInfo(entry.bytes);
        if (!meta.title && !meta.series) meta = parsed;
        else if (!meta.title && parsed.title) meta = { ...meta, ...parsed };
      } catch {
        /* Metadata is optional. */
      }
      continue;
    }
    images.push(entry);
  }

  images.sort((a, b) => naturalCompare(a.path, b.path));
  if (images.length > MAX_PAGES) {
    throw new Error(`This comic has ${images.length} images. Up to ${MAX_PAGES} pages can be converted at once.`);
  }

  const pages = [];
  for (let i = 0; i < images.length; i++) {
    if (options.onProgress) options.onProgress({ done: i + 1, total: images.length });
    try {
      const prepared = await prepareImage(images[i].bytes, images[i].path);
      if (prepared) pages.push(prepared);
    } catch (err) {
      const kind = sniffImage(images[i].bytes) || extensionKind(images[i].path);
      if (kind === 'jpeg' || kind === 'png' || kind === 'gif') {
        pages.push({ bytes: images[i].bytes, kind });
        continue;
      }
      if (pages.length === 0 && i === images.length - 1) throw err;
    }
  }

  if (!pages.length) {
    throw new Error('No comic pages found. CBZ and CBR files should contain JPEG, PNG, GIF, WebP, BMP, or AVIF images.');
  }

  return buildEpub(pages, {
    ...meta,
    fallbackTitle: titleFromFilename(options.filename),
  });
}
