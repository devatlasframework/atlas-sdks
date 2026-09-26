import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as it reached the server: the bytes that crossed the socket, not what the SDK meant. */
export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** What the server does with one request. `drop` destroys the socket after reading the request. */
export type Reply =
  | {
      readonly status: number;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
      readonly raw?: string;
    }
  | { readonly drop: true };

export interface Loopback {
  /** `http://127.0.0.1:<port>` - loopback, so the SDK accepts it without TLS. */
  readonly baseUrl: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/**
 * A real HTTP server on a loopback port that answers requests in order from `replies` (the last
 * reply repeats once they run out) and records every request it received.
 */
export async function loopback(...replies: Reply[]): Promise<Loopback> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      const reply = replies[Math.min(received.length - 1, replies.length - 1)] ?? { status: 500 };
      if ('drop' in reply) {
        request.socket.destroy();
        return;
      }
      send(response, reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function send(response: ServerResponse, reply: Exclude<Reply, { drop: true }>): void {
  const headers: Record<string, string> = {
    'x-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
    ...reply.headers,
  };
  let body = reply.raw;
  if (body === undefined && reply.body !== undefined) {
    body = JSON.stringify(reply.body);
    const problem = reply.status >= 400 && typeof reply.body === 'object';
    headers['content-type'] ??= problem ? 'application/problem+json' : 'application/json';
  }
  response.writeHead(reply.status, headers);
  response.end(body);
}

/** A problem document as the API writes one. */
export function problem(
  status: number,
  errorCode: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: `https://atlasframework.dev/problems/test-${status}`,
    title: `Refused ${status}`,
    status,
    errorCode,
    ...extra,
  };
}

/** Test seams: sleeps are recorded, not waited, and jitter is fixed. */
export function instant(): {
  sleeps: number[];
  internals: { sleep: (ms: number) => Promise<void>; random: () => number };
} {
  const sleeps: number[] = [];
  return {
    sleeps,
    internals: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
    },
  };
}
