// png-squeeze-01 — lossless PNG re-encoder.
// Reads /input/<id>/image.png (1280x720 RGBA), writes the smallest lossless
// PNG it can to /output/<id>/image.png. Pure Node 22 stdlib.
// Strategy: pick the best colour form (palette / grey / RGB / RGBA, with tRNS
// where it helps), pick the best row filter per form by real deflate cost,
// then compress with a cost-aware lazy LZ77 + optimal Huffman encoder, and
// keep whichever is smaller: that encoder or zlib level 9. Deterministic.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------- CRC32 / Adler32 ----------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf, off, len) {
  let c = 0xffffffff;
  for (let i = off; i < off + len; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(data) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------- DEFLATE tables (RFC 1951) ----------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_SYM = new Uint16Array(259);
const LEN_EBITS = new Uint8Array(259);
const LEN_EVAL = new Uint16Array(259);
for (let s = 0; s < 29; s++) {
  for (let v = LEN_BASE[s]; v <= (s === 28 ? 258 : LEN_BASE[s + 1] - 1); v++) {
    LEN_SYM[v] = 257 + s;
    LEN_EBITS[v] = LEN_EXT[s];
    LEN_EVAL[v] = v - LEN_BASE[s];
  }
}
const DIST_SYM = new Uint16Array(32769);
const DIST_EBITS = new Uint8Array(32769);
const DIST_EVAL = new Uint16Array(32769);
for (let s = 0; s < 30; s++) {
  const hi = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
  for (let v = DIST_BASE[s]; v <= hi; v++) {
    DIST_SYM[v] = s;
    DIST_EBITS[v] = DIST_EXT[s];
    DIST_EVAL[v] = v - DIST_BASE[s];
  }
}
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);
const LEN_BOUNDARIES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

// Length-limited Huffman lengths (zlib gen_bitlen method): build the tree,
// count depths, fold any overflow above maxBits down the standard way, then
// assign the shortest lengths to the most frequent symbols.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  const lengths = new Uint8Array(n);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  const heapF = [];
  const heapS = [];
  const push = (f, s) => {
    heapF.push(f); heapS.push(s);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const tf = heapF[p]; heapF[p] = heapF[i]; heapF[i] = tf;
      const ts = heapS[p]; heapS[p] = heapS[i]; heapS[i] = ts;
      i = p;
    }
  };
  const pop = () => {
    const tf = heapF[0], ts = heapS[0];
    const lf = heapF.pop(), ls = heapS.pop();
    if (heapF.length > 0) {
      heapF[0] = lf; heapS[0] = ls;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        const tf2 = heapF[m]; heapF[m] = heapF[i]; heapF[i] = tf2;
        const ts2 = heapS[m]; heapS[m] = heapS[i]; heapS[i] = ts2;
        i = m;
      }
    }
    return [tf, ts];
  };
  for (const s of syms) push(freq[s], s);
  const parent = new Int32Array(2 * n).fill(-1);
  let nextNode = n;
  while (heapF.length > 1) {
    const [f1, s1] = pop();
    const [f2, s2] = pop();
    const node = nextNode++;
    parent[s1] = node; parent[s2] = node;
    push(f1 + f2, node);
  }
  const depth = new Uint8Array(2 * n);
  for (const s of syms) {
    let d = 0, x = s;
    while (parent[x] !== -1) { d++; x = parent[x]; }
    depth[s] = d;
  }
  const blCount = new Uint16Array(maxBits + 1);
  let overflow = 0;
  for (const s of syms) {
    if (depth[s] > maxBits) overflow++;
    else blCount[depth[s]]++;
  }
  if (overflow > 0) {
    do {
      let m = maxBits - 1;
      while (m > 0 && blCount[m] === 0) m--;
      if (m === 0) break;
      blCount[m]--;
      blCount[m + 1] += 2;
      blCount[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
  }
  const sorted = syms.slice().sort((a, b) => freq[b] - freq[a] || a - b);
  let idx = 0;
  for (let len = 1; len <= maxBits; len++) {
    for (let k = 0; k < blCount[len]; k++) {
      if (idx < sorted.length) lengths[sorted[idx++]] = len;
    }
  }
  for (; idx < sorted.length; idx++) lengths[sorted[idx]] = maxBits;
  return lengths;
}
function codesFromLengths(lens) {
  const maxBits = Math.max(...lens);
  const blCount = new Uint32Array(maxBits + 1);
  for (let i = 0; i < lens.length; i++) if (lens[i] > 0) blCount[lens[i]]++;
  const nextCode = new Uint32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint32Array(lens.length);
  for (let i = 0; i < lens.length; i++) {
    if (lens[i] > 0) codes[i] = nextCode[lens[i]]++;
  }
  return codes;
}

// ---------------- bit writer ----------------
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  write(code, len) {
    this.acc |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeRev(code, len) {
    // Huffman codes are emitted most-significant-bit first.
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | ((code >> i) & 1); }
    this.write(rev, len);
  }
  align() {
    if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
  }
  result() { return new Uint8Array(this.bytes); }
}

// ---------------- token costs from a token stream ----------------
function costsFromTokens(t) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  for (let i = 0; i < t.ntok; i++) {
    const s = t.sym[i];
    if (s < 256) litFreq[s]++;
    else if (s === 256) litFreq[256]++;
    else { litFreq[s]++; distFreq[t.dsym[i]]++; }
  }
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  const litCost = new Float64Array(288);
  const lenCost = new Float64Array(288);
  const distCost = new Float64Array(30);
  for (let i = 0; i < 288; i++) {
    litCost[i] = litLen[i] || 12;
    lenCost[i] = litLen[i] || 12;
  }
  for (let i = 0; i < 30; i++) distCost[i] = distLen[i] || 8;
  return { litCost, lenCost, distCost };
}

// ---------------- cost-aware lazy LZ77 parse ----------------
// At each position, find the longest and the cheapest (savings) match via a
// 3-byte hash chain, then decide literal vs match with a one-step lookahead.
function parseCostAware(data, litCost, lenCost, distCost, maxChain, goodLen) {
  const n = data.length;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const litPrefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) litPrefix[i + 1] = litPrefix[i] + litCost[data[i]];
  const symCap = n + 1;
  const sym = new Int32Array(symCap);
  const dsym = new Int32Array(symCap);
  const lextra = new Int32Array(symCap);
  const dextra = new Int32Array(symCap);
  let ntok = 0;
  const hashAt = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
  const bestMatch = (i) => {
    if (i + 2 >= n) return [0, 0];
    const h = hashAt(i);
    let cand = head[h];
    const maxDist = i < 32768 ? i : 32768;
    let depth = 0;
    let chainLimit = maxChain;
    const d0 = data[i], d1 = data[i + 1], d2 = data[i + 2];
    let bestLen = 0, bestDist = 0;
    let saveLen = 0, saveDist = 0, bestSave = 0;
    const base = litPrefix[i];
    while (cand >= 0 && depth < chainLimit) {
      const dist = i - cand;
      if (dist > maxDist) break;
      if (data[cand] === d0 && data[cand + 1] === d1 && data[cand + 2] === d2) {
        const maxLen = Math.min(258, n - i);
        let len = 3;
        while (len < maxLen && data[cand + len] === data[i + len]) len++;
        if (len > bestLen) {
          bestLen = len; bestDist = dist;
          if (len >= goodLen && chainLimit === maxChain) chainLimit = Math.max(4, maxChain >> 2);
          if (len >= maxLen) break;
        }
        const save = (litPrefix[i + len] - base) - (lenCost[LEN_SYM[len]] + LEN_EBITS[len] + distCost[DIST_SYM[dist]] + DIST_EBITS[dist]);
        if (save > bestSave) { bestSave = save; saveLen = len; saveDist = dist; }
      }
      cand = prev[cand];
      depth++;
    }
    // choose the savings-best match when it is meaningfully cheaper than the longest
    if (saveLen >= 3 && saveLen < bestLen) {
      const costLong = lenCost[LEN_SYM[bestLen]] + LEN_EBITS[bestLen] + distCost[DIST_SYM[bestDist]] + DIST_EBITS[bestDist];
      const costSave = lenCost[LEN_SYM[saveLen]] + LEN_EBITS[saveLen] + distCost[DIST_SYM[saveDist]] + DIST_EBITS[saveDist];
      const litTail = litPrefix[i + bestLen] - litPrefix[i + saveLen];
      if (costSave + litTail < costLong - 0.5) return [saveLen, saveDist];
    }
    return [bestLen, bestDist];
  };
  const insertPos = (i) => {
    if (i + 2 >= n) return;
    const h = hashAt(i);
    prev[i] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    const [len, dist] = bestMatch(i);
    if (len >= 3) {
      // one-step lookahead: is the next position much better?
      let take = true;
      if (len < 8 && i + 1 < n) {
        const [len2, dist2] = bestMatch(i + 1);
        if (len2 >= 4) {
          const cNow = lenCost[LEN_SYM[len]] + LEN_EBITS[len] + distCost[DIST_SYM[dist]] + DIST_EBITS[dist];
          const cNext = litCost[data[i]] + lenCost[LEN_SYM[len2]] + LEN_EBITS[len2] + distCost[DIST_SYM[dist2]] + DIST_EBITS[dist2];
          if (cNext < cNow - 1) take = false;
        }
      }
      if (take) {
        sym[ntok] = LEN_SYM[len]; dsym[ntok] = DIST_SYM[dist];
        lextra[ntok] = LEN_EVAL[len]; dextra[ntok] = DIST_EVAL[dist];
        ntok++;
        for (let k = 0; k < len; k++) insertPos(i + k);
        i += len;
        continue;
      }
    }
    sym[ntok] = data[i]; dsym[ntok] = -1; lextra[ntok] = 0; dextra[ntok] = 0;
    ntok++;
    insertPos(i);
    i++;
  }
  sym[ntok] = 256; dsym[ntok] = -1; lextra[ntok] = 0; dextra[ntok] = 0;
  ntok++;
  return { sym, dsym, lextra, dextra, ntok };
}

// ---------------- encode tokens into DEFLATE blocks ----------------
function encodeTokensBlocked(t, blockBytes) {
  const w = new BitWriter();
  let idx = 0;
  while (idx < t.ntok) {
    // find block end: accumulate tokens until blockBytes of source bytes
    let bytes = 0;
    let end = idx;
    while (end < t.ntok) {
      const s = t.sym[end];
      if (s === 256) { end++; break; }
      bytes += s < 256 ? 1 : LEN_BASE[s - 257] + t.lextra[end];
      end++;
      if (bytes >= blockBytes && end < t.ntok) break;
    }
    const isFinal = end >= t.ntok;
    // Every block, final or not, ends with the 256 end-of-block symbol.
    // Non-final blocks need one appended (the stream's own 256 lives in the
    // final block only).
    const litFreq = new Float64Array(288);
    const distFreq = new Float64Array(30);
    for (let k = idx; k < end; k++) {
      const s = t.sym[k];
      if (s < 256) litFreq[s]++;
      else if (s === 256) litFreq[256]++;
      else { litFreq[s]++; distFreq[t.dsym[k]]++; }
    }
    if (!isFinal) litFreq[256]++;
    const litLen = huffmanLengths(litFreq, 15);
    const distLen = huffmanLengths(distFreq, 15);
    const litCode = codesFromLengths(litLen);
    const distCode = codesFromLengths(distLen);
    // count used symbols for HLIT/HDIST trimming
    let hlit = 29;
    while (hlit > 0 && litLen[256 + hlit] === 0) hlit--;
    hlit = 257 + hlit;
    let hdist = 29;
    while (hdist > 0 && distLen[1 + hdist] === 0) hdist--;
    hdist = 1 + hdist;
    // code-length code
    const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    const clFreq = new Float64Array(19);
    const clSeq = [];
    const emitCL = (sym, count) => {
      // run-length encode the combined lit+dist lengths
      if (sym === 0) {
        let c = count;
        while (c >= 11) {
          const take = Math.min(c - 11, 127); // symbol 18: 11 + take zeros
          clSeq.push([18, take]);
          c -= 11 + take;
        }
        if (c >= 3) { clSeq.push([17, c - 3]); c = 0; } // symbol 17: 3 + extra zeros
        for (let q = 0; q < c; q++) clSeq.push([0, 0]);
      } else {
        clSeq.push([sym, 0]);
        let rest = count - 1;
        while (rest >= 3) {
          const run = Math.min(rest, 6);
          clSeq.push([16, run - 3]);
          rest -= run;
        }
        for (let q = 0; q < rest; q++) clSeq.push([sym, 0]);
      }
    };
    let runSym = -1, runCount = 0;
    const flushRun = () => { if (runCount > 0) emitCL(runSym, runCount); runSym = -1; runCount = 0; };
    const pushLen = (v) => {
      if (v === runSym) { runCount++; }
      else { flushRun(); runSym = v; runCount = 1; }
    };
    for (let s = 0; s < hlit; s++) pushLen(litLen[s]);
    for (let s = 0; s < hdist; s++) pushLen(distLen[s]);
    flushRun();
    for (const [s] of clSeq) clFreq[s]++;
    const clLen = huffmanLengths(clFreq, 7);
    const clCode = codesFromLengths(clLen);
    let hclen = 19;
    while (hclen > 4 && clLen[order[hclen - 1]] === 0) hclen--;
    // block header
    w.write(isFinal ? 1 : 0, 1);
    w.write(2, 2); // dynamic Huffman
    w.write(hlit - 257, 5);
    w.write(hdist - 1, 5);
    w.write(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) w.write(clLen[order[k]], 3);
    for (const [s, extra] of clSeq) {
      w.writeRev(clCode[s], clLen[s]);
      if (s === 16) w.write(extra, 2);
      else if (s === 17) w.write(extra, 3);
      else if (s === 18) w.write(extra, 7);
    }
    // tokens
    for (let k = idx; k < end; k++) {
      const s = t.sym[k];
      if (s < 256) {
        w.writeRev(litCode[s], litLen[s]);
      } else if (s === 256) {
        w.writeRev(litCode[256], litLen[256]);
      } else {
        w.writeRev(litCode[s], litLen[s]);
        const eb = LEN_EBITS[LEN_BASE[s - 257] + t.lextra[k]];
        if (eb > 0) w.write(t.lextra[k], eb);
        const d = t.dsym[k];
        w.writeRev(distCode[d], distLen[d]);
        const db = DIST_EXT[d];
        if (db > 0) w.write(t.dextra[k], db);
      }
    }
    if (!isFinal) w.writeRev(litCode[256], litLen[256]);
    idx = end;
  }
  w.align();
  return w.result();
}

function wrapZlib(body, data) {
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0xda;
  out.set(body, 2);
  const a = adler32(data);
  out[2 + body.length] = (a >>> 24) & 0xff;
  out[3 + body.length] = (a >>> 16) & 0xff;
  out[4 + body.length] = (a >>> 8) & 0xff;
  out[5 + body.length] = a & 0xff;
  return out;
}

// Compress one filtered byte stream: my encoder vs zlib level 9, keep smaller.
function compressStream(data) {
  const z9 = deflateSync(data, { level: 9, memLevel: 9 });
  let litCost = new Float64Array(288);
  let lenCost = new Float64Array(288);
  let distCost = new Float64Array(30);
  for (let i = 0; i < 288; i++) litCost[i] = FIXED_LIT_LEN[i];
  for (let s = 0; s < 29; s++) lenCost[257 + s] = 8;
  for (let i = 0; i < 30; i++) distCost[i] = 5;
  const tokens = parseCostAware(data, litCost, lenCost, distCost, 4096, 32);
  const mine = wrapZlib(encodeTokensBlocked(tokens, 262144), data);
  return mine.length <= z9.length ? mine : z9;
}

// ---------------- PNG decode ----------------
function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function decodePng(buf) {
  let at = 8;
  let width = 0, height = 0, bitDepth = 8, colourType = 6;
  let plte = null, trns = null;
  const idatParts = [];
  while (at + 8 <= buf.length) {
    const len = readU32(buf, at);
    const type = String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = readU32(data, 0); height = readU32(data, 4);
      bitDepth = data[8]; colourType = data[9];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const idat = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of idatParts) { idat.set(p, off); off += p.length; }
  const raw = inflateSync(idat);
  // channels per pixel for the source colour type
  const ch = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
  const bpp = ch * (bitDepth / 8);
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const v = row[x];
      if (f === 0) cur[x] = v;
      else if (f === 1) cur[x] = (v + a) & 0xff;
      else if (f === 2) cur[x] = (v + b) & 0xff;
      else if (f === 3) cur[x] = (v + ((a + b) >> 1)) & 0xff;
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        cur[x] = (v + pr) & 0xff;
      }
    }
    // expand to RGBA
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colourType === 6) {
        rgba[o] = cur[x * 4]; rgba[o + 1] = cur[x * 4 + 1]; rgba[o + 2] = cur[x * 4 + 2]; rgba[o + 3] = cur[x * 4 + 3];
      } else if (colourType === 2) {
        rgba[o] = cur[x * 3]; rgba[o + 1] = cur[x * 3 + 1]; rgba[o + 2] = cur[x * 3 + 2]; rgba[o + 3] = 255;
      } else if (colourType === 0) {
        rgba[o] = cur[x]; rgba[o + 1] = cur[x]; rgba[o + 2] = cur[x]; rgba[o + 3] = 255;
      } else if (colourType === 4) {
        rgba[o] = cur[x * 2]; rgba[o + 1] = cur[x * 2]; rgba[o + 2] = cur[x * 2]; rgba[o + 3] = cur[x * 2 + 1];
      } else if (colourType === 3) {
        const idx = cur[x];
        rgba[o] = plte[idx * 3]; rgba[o + 1] = plte[idx * 3 + 1]; rgba[o + 2] = plte[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, rgba };
}

// ---------------- row filters ----------------
function filterRow(row, prev, bpp, type) {
  const out = new Uint8Array(row.length + 1);
  out[0] = type;
  if (type === 0) {
    out.set(row, 1);
  } else if (type === 1) {
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      out[i + 1] = (row[i] - a) & 0xff;
    }
  } else if (type === 2) {
    for (let i = 0; i < row.length; i++) out[i + 1] = (row[i] - prev[i]) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      out[i + 1] = (row[i] - ((a + prev[i]) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[i + 1] = (row[i] - pr) & 0xff;
    }
  }
  return out;
}
function rowAbsSum(frow) {
  let s = 0;
  for (let i = 1; i < frow.length; i++) {
    const v = frow[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
// Filter a whole image's sample bytes. `choice`: 0..4 fixed, or 'best' = per-row
// cheapest of 0..4 by absolute-value sum (a good proxy for deflate cost).
function filterImage(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const out = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * stride, (y + 1) * stride);
    let frow;
    if (choice === 'best') {
      let bestType = 0, bestSum = Infinity, bestRow = null;
      for (let t = 0; t <= 4; t++) {
        const cand = filterRow(row, prev, bpp, t);
        const s = rowAbsSum(cand);
        if (s < bestSum) { bestSum = s; bestType = t; bestRow = cand; }
      }
      frow = bestRow;
    } else {
      frow = filterRow(row, prev, bpp, choice);
    }
    out.set(frow, y * (stride + 1));
    prev.set(row);
  }
  return out;
}

// ---------------- colour forms ----------------
function analyse(rgba) {
  const n = rgba.length / 4;
  let grey = true, opaque = true;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    const e = map.get(key);
    if (e) { e.count++; } else { map.set(key, { r, g, b, a, count: 1, first: i }); }
  }
  return { grey, opaque, colours: map };
}

// Build sample bytes + palette for a form. Returns null when not applicable.
function buildForm(rgba, width, height, kind, order, analysis) {
  const n = width * height;
  if (kind === 'palette') {
    if (analysis.colours.size > 256) return null;
    const cols = [...analysis.colours.values()];
    if (order === 'count') cols.sort((x, y) => y.count - x.count || x.first - y.first);
    else if (order === 'lum') cols.sort((x, y) => (0.299 * x.r + 0.587 * x.g + 0.114 * x.b) - (0.299 * y.r + 0.587 * y.g + 0.114 * y.b) || x.first - y.first);
    else cols.sort((x, y) => x.first - y.first);
    const index = new Map();
    const plte = new Uint8Array(cols.length * 3);
    const trns = new Uint8Array(cols.length);
    let hasAlpha = false;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      index.set((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a, i);
      plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
      trns[i] = c.a;
      if (c.a !== 255) hasAlpha = true;
    }
    const samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const key = (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
      samples[i] = index.get(key);
    }
    return { colourType: 3, bpp: 1, samples, plte, trns: hasAlpha ? trns : null };
  }
  if (kind === 'grey') {
    if (!analysis.grey) return null;
    const samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
    return { colourType: 0, bpp: 1, samples, plte: null, trns: null };
  }
  if (kind === 'greyalpha') {
    if (!analysis.grey) return null;
    const samples = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { samples[i * 2] = rgba[i * 4]; samples[i * 2 + 1] = rgba[i * 4 + 3]; }
    return { colourType: 4, bpp: 2, samples, plte: null, trns: null };
  }
  if (kind === 'rgb') {
    if (!analysis.opaque) return null;
    const samples = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { samples[i * 3] = rgba[i * 4]; samples[i * 3 + 1] = rgba[i * 4 + 1]; samples[i * 3 + 2] = rgba[i * 4 + 2]; }
    return { colourType: 2, bpp: 3, samples, plte: null, trns: null };
  }
  // rgba
  const samples = new Uint8Array(n * 4);
  samples.set(rgba);
  return { colourType: 6, bpp: 4, samples, plte: null, trns: null };
}

// ---------------- PNG encode ----------------
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff; out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff; out[3] = data.length & 0xff;
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const c = crc32(out, 4, 4 + data.length);
  out[8 + data.length] = (c >>> 24) & 0xff; out[9 + data.length] = (c >>> 16) & 0xff;
  out[10 + data.length] = (c >>> 8) & 0xff; out[11 + data.length] = c & 0xff;
  return out;
}
function encodePng(width, height, form, idat) {
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff; ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff; ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff; ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff; ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = form.colourType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------------- main ----------------
function processOne(inputPath, outputPath) {
  const buf = new Uint8Array(readFileSync(inputPath));
  const { width, height, rgba } = decodePng(buf);
  const analysis = analyse(rgba);
  // candidate forms, cheapest first
  const formSpecs = [];
  if (analysis.colours.size <= 256) {
    formSpecs.push(['palette', 'count']);
    formSpecs.push(['palette', 'lum']);
  }
  if (analysis.grey) {
    if (analysis.opaque) formSpecs.push(['grey', null]);
    formSpecs.push(['greyalpha', null]);
  }
  if (analysis.opaque) formSpecs.push(['rgb', null]);
  formSpecs.push(['rgba', null]);
  // Screen every (form, filter) with fast zlib level 6. Keep the best
  // candidate per colour type, then run the expensive encoder (my deflate vs
  // zlib 9) on the best two colour types. (The winner by zlib 6 is not always
  // the winner by my deflate, and the two palette orders would otherwise
  // crowd out the grey form.)
  const byType = new Map();
  for (const [kind, order] of formSpecs) {
    const form = buildForm(rgba, width, height, kind, order, analysis);
    if (!form) continue;
    for (const choice of [0, 'best', 2, 4]) {
      const filtered = filterImage(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(filtered, { level: 6, memLevel: 8 });
      const cur = byType.get(form.colourType);
      if (!cur || z.length < cur.z) byType.set(form.colourType, { form, filtered, z: z.length });
    }
  }
  const cands = [...byType.values()].sort((a, b) => a.z - b.z);
  let bestPng = null;
  for (const c of cands.slice(0, 2)) {
    const idat = compressStream(c.filtered);
    const png = encodePng(width, height, c.form, idat);
    if (!bestPng || png.length < bestPng.length) bestPng = png;
  }
  mkdirSync(outputPath.substring(0, outputPath.lastIndexOf('/')), { recursive: true });
  writeFileSync(outputPath, bestPng);
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const ids = readdirSync(inputDir).filter((d) => existsSync(`${inputDir}/${d}/image.png`)).sort();
  for (const id of ids) {
    processOne(`${inputDir}/${id}/image.png`, `${outputDir}/${id}/image.png`);
  }
}
main();
