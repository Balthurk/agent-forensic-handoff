// Keep UTF-8 decoder state across arbitrary OS pipe chunk boundaries.
// Reject malformed/truncated bytes instead of silently changing evidence.
export class Utf8Stream {
  constructor(maxBytes = 32_000_000) {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.text = '';
    this.ended = false;
  }
  push(chunk) {
    if (this.ended) throw new Error('UTF8_STREAM_CLOSED');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += bytes.length;
    if (this.bytes > this.maxBytes) throw new Error('UTF8_STREAM_BUDGET');
    this.text += this.decoder.decode(bytes, { stream: true });
  }
  end() {
    if (!this.ended) {
      this.text += this.decoder.decode();
      this.ended = true;
    }
    return this.text;
  }
}
