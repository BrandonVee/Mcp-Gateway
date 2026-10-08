import { captureCallContent } from '@mcp/shared';
import { StringDecoder } from 'node:string_decoder';

export interface RpcMetadata {
  id: string | number | null;
  method: string;
  tool: string;
  input?: string | null;
}
const label = (value: unknown) => (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value) ? value : '');
export function requestMetadata(body: unknown, httpMethod: string): RpcMetadata[] {
  try {
    if (!Buffer.isBuffer(body)) throw new Error('no body');
    const data = JSON.parse(body.toString('utf8'));
    const requests = Array.isArray(data) ? data : [data];
    if (!requests.length || requests.length > 100) throw new Error('unsupported batch');
    return requests.map((request) => {
      if (!request || typeof request !== 'object') throw new Error('invalid request');
      const id =
        typeof request.id === 'number' || (typeof request.id === 'string' && request.id.length <= 256)
          ? request.id
          : null;
      const method = label(request.method) || 'unknown';
      return {
        id,
        method,
        tool: method === 'tools/call' ? label(request.params?.name) : '',
        input: captureCallContent(request.params),
      };
    });
  } catch {
    return [{ id: null, method: 'http/' + httpMethod, tool: '' }];
  }
}

/** Bounded RPC response observer. Bytes and backpressure are handled by the proxy. */
export class ResponseObserver {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private data: string[] = [];
  private size = 0;
  private oversized = false;
  private skippingLine = false;
  constructor(
    private contentType: string,
    private result: (id: unknown, failed: boolean, error: string, output?: string | null) => void,
    private limit = 256 * 1024,
  ) {}
  private json(text: string) {
    try {
      const json = JSON.parse(text);
      for (const value of Array.isArray(json) ? json : [json]) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'id')) continue;
        if (!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')) continue;
        const failed = Object.hasOwn(value, 'error') || value.result?.isError === true;
        this.result(
          value.id,
          failed,
          Object.hasOwn(value, 'error') ? 'json_rpc_error' : failed ? 'tool_error' : '',
          captureCallContent(value.error ?? value.result),
        );
      }
    } catch {
      /* Parsing failure never changes the forwarded response. */
    }
  }
  private line(line: string) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) {
      if (!this.oversized && this.data.length) this.json(this.data.join('\n'));
      this.data = [];
      this.size = 0;
      this.oversized = false;
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      this.size += data.length;
      if (this.size > this.limit) {
        this.data = [];
        this.oversized = true;
      }
      if (!this.oversized) this.data.push(data);
    }
  }
  write(chunk: Buffer) {
    if (!this.contentType.includes('json') && !this.contentType.includes('text/event-stream')) return;
    const decoded = this.decoder.write(chunk);
    if (!this.contentType.includes('text/event-stream')) {
      if (this.buffer.length + decoded.length > this.limit) {
        this.buffer = '';
        this.oversized = true;
      }
      if (!this.oversized) this.buffer += decoded;
      return;
    }
    // Process a chunk incrementally; a single huge line cannot grow retained memory.
    for (const char of decoded) {
      if (char === '\n') {
        if (!this.skippingLine) this.line(this.buffer);
        this.buffer = '';
        this.skippingLine = false;
      } else if (!this.skippingLine) {
        this.buffer += char;
        if (this.buffer.length > this.limit) {
          this.buffer = '';
          this.skippingLine = true;
          this.oversized = true;
          this.data = [];
        }
      }
    }
  }
  end() {
    const tail = this.decoder.end();
    if (tail && this.buffer.length < this.limit) this.buffer += tail;
    if (this.contentType.includes('text/event-stream')) {
      if (!this.skippingLine && this.buffer) this.line(this.buffer);
      this.line('');
    } else if (!this.oversized) this.json(this.buffer);
    this.buffer = '';
    this.data = [];
  }
}
