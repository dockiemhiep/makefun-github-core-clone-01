import { METHODS, STATUS_CODES, createServer as createHttpServer, maxHeaderSize } from 'node:http';
import {
  createServer,
  Server,
  type Socket,
} from 'node:net';

export interface BufferedRequest {
  method: string;
  url: string;
  headers: { authorization?: string; host?: string; 'git-protocol'?: string };
  body: Buffer;
}

type Headers = Record<string, string | number> | string[];

export interface HttpResponse {
  sendDate: boolean;
  writeHead(status: number, headers: Headers): unknown;
  end(body?: Buffer | string): unknown;
}

type HotDispatch = (method: string, target: string, authorised: boolean, gitV2: boolean,
  input: Buffer, bodyStart: number, bodyEnd: number) => Buffer | undefined;
type BufferedDispatch = (req: BufferedRequest, res: HttpResponse) => Promise<void>;
type HttpServer = ReturnType<typeof createHttpServer>;

const REQUEST_LINE_END = Buffer.from(' HTTP/1.1\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_RAW_BODY = 4 * 1024 * 1024;
const DEADLINE_CHECK_INTERVAL = 30_000;
const KEEP_ALIVE = 'Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n';
const BAD_REQUEST = Buffer.from('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
const REQUEST_TIMEOUT = Buffer.from('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
const INTERNAL_ERROR = Buffer.from('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
const EMPTY = Buffer.alloc(0);
const KNOWN_METHODS = new Set(METHODS);
const FIELD_NAME = new Uint8Array(256);
for (const byte of Buffer.from("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")) FIELD_NAME[byte] = 1;

function statusLine(status: number): string {
  return `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n`;
}

function joinWire(head: string, body: Buffer | string): Buffer {
  // Node encodes the headers with the first string body write, and uses Latin-1 for Buffer bodies.
  if (typeof body === 'string') return Buffer.from(head + body, 'utf8');
  const wire = Buffer.allocUnsafe(head.length + body.length);
  wire.write(head, 0, head.length, 'latin1');
  body.copy(wire, head.length);
  return wire;
}

const JSON_OK = statusLine(200) + 'content-type: application/json; charset=utf-8\r\ncontent-length: ';
const JSON_CREATED = statusLine(201) + 'content-type: application/json; charset=utf-8\r\ncontent-length: ';

export function jsonWire(status: number, text: string): Buffer {
  const prefix = status === 200 ? JSON_OK : status === 201 ? JSON_CREATED
    : statusLine(status) + 'content-type: application/json; charset=utf-8\r\ncontent-length: ';
  return Buffer.from(prefix + Buffer.byteLength(text) + '\r\nx-github-request-id: MF-FORGE\r\n' + KEEP_ALIVE + text);
}

export function bytesWire(status: number, body: Buffer, type: string): Buffer {
  return joinWire(statusLine(status) + `content-type: ${type}\r\ncontent-length: ${body.length}\r\n` + KEEP_ALIVE, body);
}

class BufferedResponse implements HttpResponse {
  sendDate = false;
  status = 200;
  head = '';
  connection: RawHttpConnection;
  headOnly: boolean;

  constructor(connection: RawHttpConnection, headOnly: boolean) {
    this.connection = connection;
    this.headOnly = headOnly;
  }

  writeHead(status: number, headers: Headers): void {
    this.status = status;
    this.head = statusLine(status);
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.addHeader(headers[i], headers[i + 1]);
    } else {
      for (const [name, value] of Object.entries(headers)) this.addHeader(name, value);
    }
  }

  addHeader(name: string, value: string | number): void {
    if ((this.status === 204 || this.status === 304) && name.toLowerCase() === 'content-length') return;
    this.head += `${name}: ${value}\r\n`;
  }

  end(body: Buffer | string = EMPTY): void {
    const omitBody = this.headOnly || this.status === 204 || this.status === 304;
    this.connection.write(joinWire(this.head + KEEP_ALIVE, omitBody ? EMPTY : body));
  }
}

function dispatchBuffered(connection: RawHttpConnection, input: Buffer, start: number, end: number): void {
  const { method, target, hostStart, hostEnd, authorised, gitV2, server } = connection;
  const request: BufferedRequest = {
    method,
    url: target,
    headers: {
      authorization: authorised ? server.bearer : undefined,
      host: hostStart < 0 ? undefined : input.toString('latin1', hostStart, hostEnd),
      'git-protocol': gitV2 ? 'version=2' : undefined,
    },
    body: start === end ? EMPTY : input.subarray(start, end),
  };
  server.bufferedDispatch(request, new BufferedResponse(connection, method === 'HEAD')).then(
    () => connection.afterDispatch(),
    () => connection.socket.end(INTERNAL_ERROR),
  );
}

function lower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

function lowerEquals(input: Buffer, start: number, end: number, word: string): boolean {
  if (end - start !== word.length) return false;
  for (let i = 0; i < word.length; i++) {
    if (lower(input[start + i]) !== word.charCodeAt(i)) return false;
  }
  return true;
}

function closesConnection(input: Buffer, start: number, end: number): boolean {
  // Both Connection and the legacy Proxy-Connection are interpreted by llhttp.
  for (let pos = start; pos < end;) {
    while (input[pos] === 32 || input[pos] === 9) pos++;
    const tokenStart = pos;
    while (pos < end && input[pos] !== 44) pos++;
    let tokenEnd = pos++;
    while (tokenEnd > tokenStart && (input[tokenEnd - 1] === 32 || input[tokenEnd - 1] === 9)) tokenEnd--;
    if (lowerEquals(input, tokenStart, tokenEnd, 'close')) return true;
  }
  return false;
}

function validLineBreaks(input: Buffer, start: number): boolean {
  for (let i = start; i < input.length; i++) {
    const byte = input[i];
    if (byte === 10 && input[i - 1] !== 13) return false;
    if (byte === 13 && i + 1 < input.length && input[i + 1] !== 10) return false;
  }
  return true;
}

function requestMethod(input: Buffer, start: number, end: number): string {
  if (end - start === 3 && input[start] === 71 && input[start + 1] === 69 && input[start + 2] === 84) return 'GET';
  if (end - start === 4 && input[start] === 80 && input[start + 1] === 79 && input[start + 2] === 83 && input[start + 3] === 84) return 'POST';
  const method = input.toString('latin1', start, end);
  return method !== 'CONNECT' && KNOWN_METHODS.has(method) ? method : '';
}

function decimalLength(input: Buffer, start: number, end: number): number {
  if (start === end) return -1;
  let length = 0;
  for (let i = start; i < end; i++) {
    const digit = input[i] - 48;
    if (digit < 0 || digit > 9) return -1;
    length = length * 10 + digit;
    if (length > MAX_RAW_BODY) return -1;
  }
  return length;
}

function matchesBearer(input: Buffer, start: number, end: number, bearer: Buffer): boolean {
  if (end - start !== bearer.length || bearer.length === 0) return false;
  for (let i = 0; i < bearer.length; i++) {
    if (input[start + i] !== bearer[i]) return false;
  }
  return true;
}

const VERSION_2 = Buffer.from('version=2');

function hasGitV2(input: Buffer, start: number, end: number): boolean {
  for (let i = start; i <= end - VERSION_2.length; i++) {
    let n = 0;
    while (n < VERSION_2.length && input[i + n] === VERSION_2[n]) n++;
    if (n === VERSION_2.length) return true;
  }
  return false;
}

const rawConnection = Symbol('rawHttpConnection');
type RawSocket = Socket & { [rawConnection]?: RawHttpConnection };

function onData(this: RawSocket, input: Buffer): void {
  this[rawConnection]!.receive(input);
}

function onDrain(this: RawSocket): void {
  this[rawConnection]!.continueReading();
}

function onClose(this: RawSocket): void {
  const connection = this[rawConnection]!;
  connection.server.connections.delete(connection);
  delete this[rawConnection];
}

function onError(this: Socket): void {
  this.destroy();
}

function onEnd(this: RawSocket): void {
  // A peer can half-close its write side while pipelined responses are pending.
  const connection = this[rawConnection]!;
  if (!connection.dispatching && !this.writableNeedDrain) connection.finishInput();
}

function onIdle(this: RawSocket): void {
  if (this[rawConnection]!.idle) this.destroy();
}

class RawHttpConnection {
  socket: RawSocket;
  server: Transport;
  pending: Buffer | null = null;
  headerScratch: Buffer | null = null;
  bodyParts: Buffer[] | null = null;
  received = 0;
  expected = 0;
  searchingFrom = 0;
  timeoutAt: number;
  idle = false;
  dispatching = false;

  // Reused parsing slots. Only the transport touches these while a request is being decoded.
  method = '';
  target = '';
  hostStart = -1;
  hostEnd = -1;
  authorised = false;
  gitV2 = false;
  bodyLength = 0;

  constructor(socket: RawSocket, server: Transport) {
    this.socket = socket;
    this.server = server;
    this.timeoutAt = Date.now() + server.fallback.headersTimeout;
    socket[rawConnection] = this;
    socket.on('data', onData);
    socket.on('drain', onDrain);
    socket.on('close', onClose);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.setTimeout(server.fallback.keepAliveTimeout + 1000, onIdle);
  }

  receive(input: Buffer): void {
    this.idle = false;
    if (this.bodyParts) {
      this.bodyParts.push(input);
      this.received += input.length;
      if (this.received < this.expected) return;
      input = Buffer.concat(this.bodyParts, this.received);
      this.bodyParts = null;
    } else if (this.pending) {
      input = this.joinHeader(this.pending, input);
      this.pending = null;
    }
    this.drain(input);
  }

  joinHeader(first: Buffer, next: Buffer): Buffer {
    const size = first.length + next.length;
    if (size >= maxHeaderSize) return Buffer.concat([first, next], size);
    // Grow fragmented headers in place up to the parser's size limit.
    const scratch = this.headerScratch && this.headerScratch.length >= size
      ? this.headerScratch
      : Buffer.allocUnsafe(Math.min(maxHeaderSize, Math.max(512, size * 2)));
    if (scratch.buffer !== first.buffer || scratch.byteOffset !== first.byteOffset) first.copy(scratch, 0);
    next.copy(scratch, first.length);
    this.headerScratch = scratch;
    return scratch.subarray(0, size);
  }

  drain(input: Buffer): void {
    let start = 0;
    while (start < input.length) {
      const end = input.indexOf(HEADER_END, start + this.searchingFrom);
      if (end === -1 && input.length - start < maxHeaderSize &&
          validLineBreaks(input, start + this.searchingFrom)) {
        this.pending = input.subarray(start);
        this.searchingFrom = Math.max(0, this.pending.length - HEADER_END.length + 1);
        this.timeoutAt ||= Date.now() + this.server.fallback.headersTimeout;
        return;
      }
      this.searchingFrom = 0;
      this.headerScratch = null;
      if (end === -1 || end + HEADER_END.length - start >= maxHeaderSize || !this.parse(input, start, end)) {
        this.handoff(input.subarray(start));
        return;
      }

      const bodyStart = end + HEADER_END.length;
      const bodyEnd = bodyStart + this.bodyLength;
      if (bodyEnd > input.length) {
        this.bodyParts = [input.subarray(start)];
        this.received = input.length - start;
        this.expected = bodyEnd - start;
        this.timeoutAt = Date.now() + this.server.fallback.requestTimeout;
        return;
      }

      this.timeoutAt = 0;
      // Complete cached frames include a body. HEAD uses the buffered header-only writer.
      const wire = this.method === 'HEAD' ? undefined
        : this.server.hotDispatch(this.method, this.target, this.authorised, this.gitV2, input, bodyStart, bodyEnd);
      start = bodyEnd;
      if (wire === undefined) {
        this.dispatching = true;
        this.saveRemainder(input, start);
        this.socket.pause();
        dispatchBuffered(this, input, bodyStart, bodyEnd);
        return;
      }
      if (!this.write(wire)) {
        this.saveRemainder(input, start);
        return;
      }
    }
    this.waitForRequest();
  }

  parse(input: Buffer, start: number, end: number): boolean {
    const methodEnd = input.indexOf(32, start);
    if (methodEnd <= start || methodEnd >= end) return false;
    const targetStart = methodEnd + 1;
    const targetEnd = input.indexOf(32, targetStart);
    if (targetEnd <= targetStart || targetEnd + REQUEST_LINE_END.length > end + 2) return false;
    if (input[targetStart] !== 47 && (input[targetStart] !== 42 || targetEnd - targetStart !== 1)) return false;
    for (let i = targetStart; i < targetEnd; i++) {
      if (input[i] <= 32 || input[i] >= 127) return false;
    }
    for (let i = 0; i < REQUEST_LINE_END.length; i++) {
      if (input[targetEnd + i] !== REQUEST_LINE_END[i]) return false;
    }
    const method = requestMethod(input, start, methodEnd);
    if (!method) return false;

    this.hostStart = -1;
    this.authorised = false;
    this.gitV2 = false;
    let length = -1;
    let seenAuth = false;
    let fields = 0;
    for (let pos = targetEnd + REQUEST_LINE_END.length; pos < end; ) {
      const nameStart = pos;
      while (FIELD_NAME[input[pos]]) pos++;
      const nameEnd = pos;
      if (nameStart === nameEnd || input[pos++] !== 58 || ++fields > 1000) return false;
      while (input[pos] === 32 || input[pos] === 9) pos++;
      const valueStart = pos;
      while (pos <= end && (input[pos] >= 32 && input[pos] !== 127 || input[pos] === 9)) pos++;
      if (input[pos] !== 13 || input[pos + 1] !== 10) return false;
      let valueEnd = pos;
      while (valueEnd > valueStart && (input[valueEnd - 1] === 32 || input[valueEnd - 1] === 9)) valueEnd--;
      pos += 2;

      const nameLength = nameEnd - nameStart;
      const first = input[nameStart] | 32;
      if (first === 97 && nameLength === 13 && lowerEquals(input, nameStart, nameEnd, 'authorization')) {
        if (seenAuth) return false;
        seenAuth = true;
        this.authorised = matchesBearer(input, valueStart, valueEnd, this.server.bearerBytes);
      } else if (first === 99 && nameLength === 14 && lowerEquals(input, nameStart, nameEnd, 'content-length')) {
        if (length !== -1) return false;
        length = decimalLength(input, valueStart, valueEnd);
        if (length < 0) return false;
      } else if (first === 99 && nameLength === 10 && lowerEquals(input, nameStart, nameEnd, 'connection') ||
                 first === 112 && nameLength === 16 && lowerEquals(input, nameStart, nameEnd, 'proxy-connection')) {
        if (!lowerEquals(input, valueStart, valueEnd, 'keep-alive') && closesConnection(input, valueStart, valueEnd)) return false;
      } else if (first === 103 && nameLength === 12 && lowerEquals(input, nameStart, nameEnd, 'git-protocol')) {
        this.gitV2 ||= hasGitV2(input, valueStart, valueEnd);
      } else if (first === 104 && nameLength === 4 && lowerEquals(input, nameStart, nameEnd, 'host')) {
        if (this.hostStart < 0) {
          this.hostStart = valueStart;
          this.hostEnd = valueEnd;
        }
      } else if (first === 116 && nameLength === 17 && lowerEquals(input, nameStart, nameEnd, 'transfer-encoding') ||
                 first === 101 && nameLength === 6 && lowerEquals(input, nameStart, nameEnd, 'expect') ||
                 first === 117 && nameLength === 7 && lowerEquals(input, nameStart, nameEnd, 'upgrade')) {
        return false;
      }
    }
    // Node owns the HTTP/1.1 Host requirement and its error response.
    if (this.hostStart < 0) return false;
    this.method = method;
    this.target = input.toString('latin1', targetStart, targetEnd);
    this.bodyLength = length < 0 ? 0 : length;
    return true;
  }

  write(wire: Buffer): boolean {
    const ready = this.socket.write(wire);
    if (!ready) this.socket.pause();
    return ready;
  }

  saveRemainder(input: Buffer, start: number): void {
    if (start < input.length) this.pending = input.subarray(start);
  }

  afterDispatch(): void {
    this.dispatching = false;
    this.continueReading();
  }

  continueReading(): void {
    const socket = this.socket;
    if (this.dispatching || socket.destroyed || socket.writableNeedDrain) return;
    if (this.pending) {
      const input = this.pending;
      this.pending = null;
      this.drain(input);
    } else {
      this.waitForRequest();
    }
    if (socket[rawConnection] && !this.dispatching && !socket.writableNeedDrain) {
      if (socket.readableEnded && !socket.writableEnded) this.finishInput();
      else socket.resume();
    }
  }

  waitForRequest(): void {
    if (this.socket.readableEnded) {
      this.finishInput();
    } else {
      this.idle = true;
    }
  }

  finishInput(): void {
    if (this.bodyParts) {
      // Replay the incomplete request so Node can dispatch from its headers before checking EOF.
      const input = this.bodyParts.length === 1 ? this.bodyParts[0] : Buffer.concat(this.bodyParts, this.received);
      this.handoff(input);
    } else if (this.pending) this.socket.end(BAD_REQUEST);
    else this.socket.end();
  }

  handoff(input: Buffer): void {
    const { socket, server } = this;
    server.connections.delete(this);
    socket.off('data', onData);
    socket.off('drain', onDrain);
    socket.off('close', onClose);
    socket.off('error', onError);
    socket.off('end', onEnd);
    socket.setTimeout(0);
    socket.off('timeout', onIdle);
    delete socket[rawConnection];
    // The HTTP engine manages FIN and idle timers for the rest of this socket's life.
    server.fallback.emit('connection', socket);
    socket.emit('data', input);
    if (socket.destroyed) return;
    if (socket.readableEnded) {
      // Give header-only dispatch and response completion their usual turn before the FIN.
      setImmediate(() => { if (!socket.destroyed) socket.emit('end'); });
    } else {
      socket.resume();
    }
  }
}

interface Transport {
  bearer: string;
  bearerBytes: Buffer;
  fallback: HttpServer;
  hotDispatch: HotDispatch;
  bufferedDispatch: BufferedDispatch;
  connections: Set<RawHttpConnection>;
}

export type HybridServer = Server & {
  closeIdleConnections(): void;
  closeAllConnections(): void;
};

export function createHybridServer(fallback: HttpServer, token: string, hotDispatch: HotDispatch,
  bufferedDispatch: BufferedDispatch): HybridServer {
  const bearer = `Bearer ${token}`;
  const encoded = Buffer.from(bearer, 'latin1');
  const transport: Transport = {
    bearer,
    // IncomingMessage decodes header bytes as Latin-1. Reject lossy token encodings.
    bearerBytes: token && encoded.toString('latin1') === bearer ? encoded : EMPTY,
    fallback,
    hotDispatch,
    bufferedDispatch,
    connections: new Set(),
  };

  const server = createServer({ noDelay: true, allowHalfOpen: true }, (socket) => {
    transport.connections.add(new RawHttpConnection(socket, transport));
  }) as HybridServer;
  let timeoutCheck: NodeJS.Timeout;
  server.on('listening', () => {
    // Install Node's request deadline and connection tracking without opening a second listener.
    fallback.emit('listening');
    timeoutCheck = setInterval(() => {
      const now = Date.now();
      for (const connection of transport.connections) {
        if (connection.timeoutAt && connection.timeoutAt <= now) connection.socket.end(REQUEST_TIMEOUT);
      }
    }, DEADLINE_CHECK_INTERVAL).unref();
  });
  server.on('close', () => {
    clearInterval(timeoutCheck);
    fallback.close();
  });
  server.closeIdleConnections = () => {
    for (const connection of transport.connections) {
      if (!connection.dispatching && !connection.pending && !connection.bodyParts && !connection.socket.writableLength) {
        connection.socket.destroy();
      }
    }
    fallback.closeIdleConnections();
  };
  server.closeAllConnections = () => {
    for (const connection of transport.connections) connection.socket.destroy();
    fallback.closeAllConnections();
  };
  server.close = function close(callback) {
    Server.prototype.close.call(this, callback);
    this.closeIdleConnections();
    return this;
  };
  return server;
}
