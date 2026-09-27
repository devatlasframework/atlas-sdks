"""A real HTTP server on a loopback port, so that tests read the bytes that crossed the socket."""

from __future__ import annotations

import json
import secrets
import socket
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final

from devatlasframework.sdk._transport import _Internals

KEY: Final = "unit-test-key-not-a-credential"
"""A made-up key: it is sent only to a loopback server."""
ORG: Final = "11111111-1111-4111-8111-111111111111"
END_USER: Final = "22222222-2222-4222-8222-222222222222"


@dataclass(frozen=True)
class Received:
    """One request as it reached the server: the bytes that crossed the socket."""

    method: str
    target: str
    headers: Mapping[str, str]
    body: bytes


@dataclass(frozen=True)
class Reply:
    """What the server answers one request with."""

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: object = None
    raw: bytes | None = None


class Drop:
    """Closes the connection after reading the request, as if it failed after the API acted."""


class Stall:
    """Sends the head and part of the body, then goes quiet."""


DROP: Final = Drop()
STALL: Final = Stall()


class Drip:
    """Sends a 200 and then its body one byte every 0.1 s, each byte resetting an idle timeout."""


DRIP: Final = Drip()


class SlowHead:
    """Sends the head one line every 0.15 s, then the whole body at once."""


SLOW_HEAD: Final = SlowHead()

type Script = Reply | Drop | Stall | Drip | SlowHead


def problem(status: int, error_code: str, **extra: object) -> dict[str, object]:
    """A problem document as the API writes one."""
    return {
        "type": f"https://atlasframework.dev/problems/test-{status}",
        "title": f"Refused {status}",
        "status": status,
        "errorCode": error_code,
        **extra,
    }


class Loopback:
    """Answers requests in order from `replies` (the last repeats), and records every request."""

    def __init__(self, *replies: Script) -> None:
        self.received: list[Received] = []
        self._replies = replies or (Reply(500),)
        self._stalled = threading.Event()
        loop = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def _handle(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                loop.received.append(
                    Received(
                        method=self.command,
                        target=self.path,
                        headers={name.lower(): value for name, value in self.headers.items()},
                        body=body,
                    )
                )
                script = loop._replies[min(len(loop.received), len(loop._replies)) - 1]
                if isinstance(script, Drop):
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if isinstance(script, SlowHead):
                    body = json.dumps({"keyId": "k", "orgId": ORG}).encode()
                    lines = [
                        b"HTTP/1.1 200 OK\r\n",
                        b"content-type: application/json\r\n",
                        b"x-request-id: req-slow\r\n",
                        b"content-length: " + str(len(body)).encode() + b"\r\n",
                        b"connection: close\r\n",
                        b"\r\n",
                    ]
                    for line in lines:
                        loop._stalled.wait(0.15)
                        self.wfile.write(line)
                        self.wfile.flush()
                    self.wfile.write(body)
                    self.wfile.flush()
                    self.close_connection = True
                    return
                if isinstance(script, Drip):
                    body = b'{"keyId":"' + b"k" * 200 + b'"}'
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    for byte in body:
                        if loop._stalled.wait(0.1):
                            break
                        try:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                        except OSError:
                            break
                    self.close_connection = True
                    return
                if isinstance(script, Stall):
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", "100")
                    self.end_headers()
                    self.wfile.write(b'{"keyId":')
                    self.wfile.flush()
                    loop._stalled.wait(10)
                    self.close_connection = True
                    return
                loop._send(self, script)

            do_GET = _handle  # noqa: N815
            do_POST = _handle  # noqa: N815
            do_DELETE = _handle  # noqa: N815

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self._thread.start()
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"

    @staticmethod
    def _send(handler: BaseHTTPRequestHandler, reply: Reply) -> None:
        headers = {"x-request-id": f"req-{secrets.token_hex(4)}", **reply.headers}
        payload = reply.raw
        if payload is None and reply.body is not None:
            payload = json.dumps(reply.body).encode("utf-8")
            is_problem = reply.status >= 400 and isinstance(reply.body, dict)
            headers.setdefault(
                "content-type", "application/problem+json" if is_problem else "application/json"
            )
        payload = payload or b""
        handler.send_response(reply.status)
        for name, value in headers.items():
            handler.send_header(name, value)
        handler.send_header("content-length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)

    def close(self) -> None:
        """Stops the server and releases any stalled response."""
        self._stalled.set()
        self._server.shutdown()
        self._server.server_close()


@dataclass
class Instant:
    """Test seams: sleeps are recorded, not waited, and jitter is fixed at zero."""

    sleeps: list[float] = field(default_factory=list)

    @property
    def internals(self) -> _Internals:
        return _Internals(sleep=self.sleeps.append, random=lambda: 0.0)


type Start = Callable[..., Loopback]
