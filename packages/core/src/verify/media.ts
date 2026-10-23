// The media_spec check (ROUTING §4.1): format, dimensions and duration read from the file's own headers. Pure; no
// decoder, so it works on any host and in tests. Formats: PNG, JPEG, GIF, WebP, WAV, MP3, MP4/MOV.

export interface MediaProbe {
  format: "png" | "jpeg" | "gif" | "webp" | "wav" | "mp3" | "mp4" | "unknown";
  width?: number;
  height?: number;
  durationS?: number;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => (u16be(b, at) * 0x10000 + u16be(b, at + 2)) >>> 0;
const u32le = (b: Uint8Array, at: number) => (u16le(b, at) + u16le(b, at + 2) * 0x10000) >>> 0;

function jpeg(b: Uint8Array): MediaProbe {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1] ?? 0;
    const len = u16be(b, i + 2);
    // Start-of-frame markers carry the size (C4, C8 and CC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { format: "jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
    else i += 2 + len;
  }
  return { format: "jpeg" };
}

function webp(b: Uint8Array): MediaProbe {
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 ") return { format: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = u32le(b, 21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { format: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return { format: "webp" };
}

function wav(b: Uint8Array): MediaProbe {
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= b.length) {
    const id = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    if (id === "fmt ") byteRate = u32le(b, i + 16);
    if (id === "data" && byteRate) return { format: "wav", durationS: size / byteRate };
    i += 8 + size + (size % 2);
  }
  return { format: "wav" };
}

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_RATES = [44100, 48000, 32000];

function mp3(b: Uint8Array): MediaProbe {
  let i = 0;
  if (ascii(b, 0, 3) === "ID3") {
    const size = ((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0);
    i = 10 + size;
  }
  for (; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || ((b[i + 1] ?? 0) & 0xe0) !== 0xe0) continue;
    const kbps = MP3_BITRATES[((b[i + 2] ?? 0) >> 4) & 0x0f];
    const rate = MP3_RATES[((b[i + 2] ?? 0) >> 2) & 0x03];
    if (!kbps || !rate) continue;
    // Constant bit rate estimate from the audio's size; good enough to bound a duration.
    return { format: "mp3", durationS: ((b.length - i) * 8) / (kbps * 1000) };
  }
  return { format: "mp3" };
}

/** Walks MP4 boxes for mvhd (duration) and the first track header with a size (tkhd). */
function mp4(b: Uint8Array): MediaProbe {
  const out: MediaProbe = { format: "mp4" };
  const walk = (start: number, end: number, depth: number) => {
    let i = start;
    while (i + 8 <= end && depth < 8) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1) {
        size = u32be(b, i + 8) * 2 ** 32 + u32be(b, i + 12);
        header = 16;
      } else if (size === 0) size = end - i;
      if (size < header) return;
      const body = i + header;
      if (type === "moov" || type === "trak") walk(body, Math.min(i + size, end), depth + 1);
      else if (type === "mvhd") {
        const v1 = b[body] === 1;
        const scale = u32be(b, body + (v1 ? 20 : 12));
        const dur = v1 ? u32be(b, body + 24) * 2 ** 32 + u32be(b, body + 28) : u32be(b, body + 16);
        if (scale) out.durationS = dur / scale;
      } else if (type === "tkhd" && out.width === undefined) {
        const v1 = b[body] === 1;
        const at = body + (v1 ? 88 : 76);
        const w = u32be(b, at) / 65536;
        const h = u32be(b, at + 4) / 65536;
        if (w > 0 && h > 0) {
          out.width = Math.round(w);
          out.height = Math.round(h);
        }
      }
      i += size;
    }
  };
  walk(0, b.length, 0);
  return out;
}

export function probeMedia(bytes: Uint8Array): MediaProbe {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG")
    return { format: "png", width: u32be(b, 16), height: u32be(b, 20) };
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (ascii(b, 0, 4) === "GIF8") return { format: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return wav(b);
  if (ascii(b, 4, 4) === "ftyp") return mp4(b);
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return mp3(b);
  return { format: "unknown" };
}

export interface MediaSpec {
  formats?: string[];
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Width ÷ height, e.g. 1.777 for 16:9 (1% tolerance). */
  aspect?: number;
  minDurationS?: number;
  maxDurationS?: number;
}

export function mediaSpec(probe: MediaProbe, spec: MediaSpec): { passed: boolean; problems: string[] } {
  const problems: string[] = [];
  if (spec.formats?.length && !spec.formats.includes(probe.format))
    problems.push(`format ${probe.format}, wanted ${spec.formats.join(" or ")}`);
  const sized = probe.width !== undefined && probe.height !== undefined;
  const needsSize = [
    spec.width,
    spec.height,
    spec.minWidth,
    spec.minHeight,
    spec.maxWidth,
    spec.maxHeight,
    spec.aspect,
  ].some((x) => x !== undefined);
  if (needsSize && !sized) problems.push(`could not read the size of a ${probe.format} file`);
  if (sized) {
    const w = probe.width as number;
    const h = probe.height as number;
    if (spec.width !== undefined && w !== spec.width) problems.push(`width ${w}, wanted ${spec.width}`);
    if (spec.height !== undefined && h !== spec.height) problems.push(`height ${h}, wanted ${spec.height}`);
    if (spec.minWidth !== undefined && w < spec.minWidth) problems.push(`width ${w} < ${spec.minWidth}`);
    if (spec.minHeight !== undefined && h < spec.minHeight) problems.push(`height ${h} < ${spec.minHeight}`);
    if (spec.maxWidth !== undefined && w > spec.maxWidth) problems.push(`width ${w} > ${spec.maxWidth}`);
    if (spec.maxHeight !== undefined && h > spec.maxHeight) problems.push(`height ${h} > ${spec.maxHeight}`);
    if (spec.aspect !== undefined && Math.abs(w / h - spec.aspect) / spec.aspect > 0.01)
      problems.push(`aspect ${(w / h).toFixed(3)}, wanted ${spec.aspect}`);
  }
  const timed = spec.minDurationS !== undefined || spec.maxDurationS !== undefined;
  if (timed && probe.durationS === undefined)
    problems.push(`could not read the duration of a ${probe.format} file`);
  if (probe.durationS !== undefined) {
    if (spec.minDurationS !== undefined && probe.durationS < spec.minDurationS)
      problems.push(`${probe.durationS.toFixed(1)}s < ${spec.minDurationS}s`);
    if (spec.maxDurationS !== undefined && probe.durationS > spec.maxDurationS)
      problems.push(`${probe.durationS.toFixed(1)}s > ${spec.maxDurationS}s`);
  }
  return { passed: problems.length === 0, problems };
}
