# toazw3

**Use it here: [https://vicholz.github.io/toazw3/](https://vicholz.github.io/toazw3/)**

Browser-only converter for **EPUB** and **MOBI** (also PRC / AZW) into Kindle **AZW3**. Drop one file or a whole stack. Conversion happens in this tab with WebAssembly. Nothing is uploaded.

## Features

- Bulk queue: add many ebooks, convert them one after another
- Per-file download plus **Download all as ZIP**
- Cover images from the source EPUB/MOBI are copied into the AZW3 and tagged for Kindle
- DRM-free files only — encrypted Kindle books will fail
- Works from any static web server, including GitHub Pages

## Run locally

Any static file server is enough. From this directory:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). Opening `index.html` as a `file://` URL will not load the converter.

## How it works

The UI is vanilla HTML, CSS, and JavaScript. A Web Worker loads a vendored [boko](https://github.com/zacharydenton/boko) WASM module and converts each book to AZW3. Bulk ZIP files are built in the browser with uncompressed (STORE) zip records.

## License

GPL-3.0-or-later, because the conversion engine is boko (GPL-3.0-or-later). See `LICENSE` and `vendor/boko/`.
