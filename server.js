// Business Software — receipt OCR server (online demo, phase 1).
//
// Minimal zero-dependency Node.js server. One job: read the text off a
// receipt photo so the demo APK's Scan Receipt screen can work online.
//
//   POST /api/read-receipt  { dataBase64, mimeType }  ->  { text }
//   GET  /health            ->  { ok: true, ... }
//
// OCR is server-side Tesseract (free, no API key). Photos are processed
// from a temp file that is deleted immediately after each request and
// are NEVER stored or logged.
//
// Contract matches the web app's readReceiptPhoto action:
//   request  { dataBase64: string, mimeType: "image/jpeg" | "image/png" }
//   response { text: string }   (empty string when nothing readable)
// Errors are always JSON { error: string } with a 4xx/5xx status — the
// server never crashes on a bad request.

"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";

// Same cap the web app uses for a receipt photo (10 MB here; the demo
// client already downscales photos to a 1600 px side before sending).
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Downscale photos larger than this on the long side before OCR, when a
// downscaler is available (the demo client already caps at 1600 px, so
// this only bites on direct/non-client calls).
const MAX_SIDE_PX = 3000;
// Tesseract wall-clock budget per photo; killed on expiry.
const OCR_TIMEOUT_MS = 90_000;
// Free tiers are small (Render free = 512 MB RAM); cap concurrent OCR
// runs so parallel photos cannot OOM the instance. Excess requests get
// a clean 503 instead of a crash. Override with OCR_MAX_CONCURRENT
// (measured: one Tesseract run peaks ~52 MB RSS on a 1200x1500 receipt,
// so 2 concurrent fits comfortably in 512 MB).
const MAX_CONCURRENT_OCR = Math.max(
  1,
  parseInt(process.env.OCR_MAX_CONCURRENT || "2", 10) || 2,
);

let ocrInFlight = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooBig = true;
        req.destroy();
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

// Sniff PNG/JPEG pixel dimensions from the file header (no image lib
// needed). Returns { width, height } or null when it cannot be told.
function sniffDimensions(buf) {
  try {
    // PNG: 8-byte signature, then IHDR chunk with width/height at 16/20.
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan markers for a Start-Of-Frame (0xC0-0xCF except 0xC4,
    // 0xC8, 0xCC) which carries height then width.
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
        }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) break;
        off += 2 + len;
      }
    }
  } catch {
    // Unparseable header — caller treats it as unknown dimensions.
  }
  return null;
}

// Downscale an image file with PIL (python3 + python3-pil, installed in
// the Dockerfile). Returns the downscaled file path, or null when PIL is
// unavailable / the downscale fails — the caller then OCRs the original.
function downscaleWithPil(srcPath, dstPath, maxSide) {
  return new Promise((resolve) => {
    const code = [
      "import sys",
      "from PIL import Image",
      "src, dst, max_side = sys.argv[1], sys.argv[2], int(sys.argv[3])",
      "im = Image.open(src).convert('RGB')",
      "w, h = im.size",
      "s = min(1.0, max_side / max(w, h))",
      "im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)",
      "im.save(dst, 'JPEG', quality=88)",
    ].join("\n");
    execFile(
      "python3",
      ["-c", code, srcPath, dstPath, String(maxSide)],
      { timeout: 30_000 },
      (err) => resolve(err ? null : dstPath),
    );
  });
}

function runTesseract(filePath) {
  return new Promise((resolve) => {
    execFile(
      "tesseract",
      [filePath, "stdout", "--psm", "6", "-l", "eng"],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const text = (stdout || "").trim();
        // Tesseract can exit non-zero yet still produce usable text;
        // accept the text when there is any, fail only on empty output.
        if (text) return resolve({ ok: true, text });
        const msg = err && err.killed
          ? "Reading the photo timed out — please use a smaller photo, or paste the receipt text instead."
          : "No text could be read from this photo — please use a clearer photo, or paste the receipt text instead.";
        resolve({ ok: false, error: msg });
      },
    );
  });
}

async function handleReadReceipt(req, res) {
  if (ocrInFlight >= MAX_CONCURRENT_OCR) {
    return sendJson(res, 503, {
      error: "The reader is busy right now — please try again in a few seconds.",
    });
  }
  // Declared size first: a client that says it is sending more than the
  // cap gets a clean 413 JSON instead of a dropped connection (fetch /
  // axios always send Content-Length for a JSON body). The streaming
  // guard in readBody below is the fallback for chunked bodies.
  const declared = parseInt(req.headers["content-length"] || "", 10);
  if (!Number.isNaN(declared) && declared > MAX_BODY_BYTES) {
    return sendJson(res, 413, {
      error: "The receipt photo is too large to read — please use a smaller photo, or paste the receipt text instead.",
    });
  }
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    const status = e.status || 400;
    return sendJson(res, status, {
      error: status === 413
        ? "The receipt photo is too large to read — please use a smaller photo, or paste the receipt text instead."
        : "The request could not be read.",
    });
  }
  let args;
  try {
    args = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "Request body must be JSON { dataBase64, mimeType }." });
  }
  if (!args || typeof args.dataBase64 !== "string" || args.dataBase64.length === 0) {
    return sendJson(res, 400, { error: "dataBase64 is required — please pick the photo again." });
  }
  if (args.mimeType !== "image/jpeg" && args.mimeType !== "image/png") {
    return sendJson(res, 400, { error: "mimeType must be image/jpeg or image/png." });
  }
  let bytes;
  try {
    bytes = Buffer.from(args.dataBase64, "base64");
  } catch {
    return sendJson(res, 400, { error: "dataBase64 is not valid base64." });
  }
  if (bytes.length === 0) {
    return sendJson(res, 400, { error: "The receipt photo data was empty — please pick the photo again." });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return sendJson(res, 413, {
      error: "The receipt photo is too large to read — please use a smaller photo, or paste the receipt text instead.",
    });
  }

  const ext = args.mimeType === "image/png" ? "png" : "jpg";
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "receipt-"));
  const srcPath = path.join(tmpDir, `input.${ext}`);
  try {
    await fs.promises.writeFile(srcPath, bytes);
    let ocrPath = srcPath;
    const dims = sniffDimensions(bytes);
    if (dims && Math.max(dims.width, dims.height) > MAX_SIDE_PX) {
      const smallPath = path.join(tmpDir, "input-small.jpg");
      const done = await downscaleWithPil(srcPath, smallPath, MAX_SIDE_PX);
      if (done) {
        ocrPath = done;
        log("downscaled", `${dims.width}x${dims.height} -> <=${MAX_SIDE_PX}px`);
      } else {
        log("downscale unavailable, OCRing original", `${dims.width}x${dims.height}`);
      }
    }
    ocrInFlight += 1;
    let result;
    try {
      result = await runTesseract(ocrPath);
    } finally {
      ocrInFlight -= 1;
    }
    if (!result.ok) return sendJson(res, 422, { error: result.error });
    return sendJson(res, 200, { text: result.text });
  } catch (e) {
    log("read-receipt error:", e && e.message ? e.message : e);
    return sendJson(res, 500, {
      error: "The receipt photo could not be read just now. Please try again — or paste the receipt text instead.",
    });
  } finally {
    // The photo is deleted immediately after every request, success or
    // failure. Nothing is ever stored.
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, service: "business-software-ocr", time: new Date().toISOString() });
    }
    if (req.method === "POST" && url === "/api/read-receipt") {
      return void handleReadReceipt(req, res);
    }
    if (req.method === "GET" && url === "/") {
      return sendJson(res, 200, {
        ok: true,
        service: "business-software-ocr",
        endpoints: ["GET /health", "POST /api/read-receipt"],
      });
    }
    return sendJson(res, 404, { error: "Not found." });
  } catch (e) {
    log("unhandled error:", e && e.message ? e.message : e);
    try { sendJson(res, 500, { error: "Something went wrong — please try again." }); } catch { /* socket gone */ }
  }
});

server.listen(PORT, HOST, () => {
  log(`business-software-ocr listening on ${HOST}:${PORT}`);
});
