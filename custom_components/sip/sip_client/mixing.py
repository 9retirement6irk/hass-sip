"""PCM mixing helpers shared by conference bridging and call monitoring.

Everything here works on s16le / mono PCM, the format the RTP session and
the audio sinks already use. It is deliberately dependency-free (stdlib
``array`` only) so it can run inside the RTP callbacks on the event loop:
one 20 ms frame is 160 or 320 samples.
"""

from __future__ import annotations

import array
import sys

_BIG_ENDIAN = sys.byteorder == "big"
_MAX = 32767
_MIN = -32768


def _to_samples(pcm_le: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(pcm_le[: len(pcm_le) & ~1])
    if _BIG_ENDIAN:
        samples.byteswap()
    return samples


def _to_bytes(samples: array.array) -> bytes:
    if _BIG_ENDIAN:
        samples = array.array("h", samples)
        samples.byteswap()
    return samples.tobytes()


def mix_pcm(base: bytes, extra: bytes) -> bytes:
    """Return ``base`` + ``extra`` with saturation.

    The result always has the length of ``base``: a shorter ``extra`` only
    covers the start, a longer one is truncated.
    """
    if not extra:
        return base
    if not base:
        return base
    out = _to_samples(base)
    add = _to_samples(extra)
    n = min(len(out), len(add))
    for i in range(n):
        value = out[i] + add[i]
        if value > _MAX:
            value = _MAX
        elif value < _MIN:
            value = _MIN
        out[i] = value
    return _to_bytes(out)


def resample_pcm(pcm_le: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Convert between the two rates the codecs use (8 kHz and 16 kHz).

    Stateless on purpose: 2x up is linear interpolation inside the frame and
    2x down averages sample pairs. That is plenty for telephone speech and
    keeps bridging free of per-stream state. Other ratios fall back to
    nearest-sample picking so an unexpected codec still produces audio.
    """
    if src_rate == dst_rate or not pcm_le or src_rate <= 0 or dst_rate <= 0:
        return pcm_le
    src = _to_samples(pcm_le)
    n = len(src)
    if n == 0:
        return b""
    if dst_rate == src_rate * 2:
        out = array.array("h", bytes(n * 4))
        for i in range(n):
            cur = src[i]
            nxt = src[i + 1] if i + 1 < n else cur
            out[2 * i] = cur
            out[2 * i + 1] = (cur + nxt) >> 1
        return _to_bytes(out)
    if src_rate == dst_rate * 2:
        half = n // 2
        out = array.array("h", bytes(half * 2))
        for i in range(half):
            out[i] = (src[2 * i] + src[2 * i + 1]) >> 1
        return _to_bytes(out)
    n_out = max(1, n * dst_rate // src_rate)
    out = array.array("h", bytes(n_out * 2))
    for i in range(n_out):
        out[i] = src[min(n - 1, i * src_rate // dst_rate)]
    return _to_bytes(out)


class MixInputs:
    """Named PCM queues that are summed one chunk at a time.

    Each producer (for example "the other line's received audio") pushes
    into its own queue. The consumer pops a fixed number of bytes on its own
    clock and gets the sum of every queue that has that much audio ready.

    A queue starts delivering once it holds ``prime_frames`` chunks, so a
    producer with network jitter does not underrun on every other tick, and
    it is capped at ``max_frames`` chunks so clock drift between the two
    calls can never build up more than a fraction of a second of delay.
    """

    def __init__(self, max_frames: int = 8, prime_frames: int = 2) -> None:
        self._max_frames = max(2, max_frames)
        self._prime_frames = max(1, prime_frames)
        self._buffers: dict[str, bytearray] = {}
        self._primed: dict[str, bool] = {}

    def __bool__(self) -> bool:
        return bool(self._buffers)

    def push(self, key: str, pcm_le: bytes, frame_bytes: int) -> None:
        if not pcm_le or frame_bytes <= 0:
            return
        buf = self._buffers.get(key)
        if buf is None:
            buf = self._buffers[key] = bytearray()
            self._primed[key] = False
        buf.extend(pcm_le)
        cap = frame_bytes * self._max_frames
        if len(buf) > cap:
            del buf[: len(buf) - cap]

    def pop(self, nbytes: int) -> bytes | None:
        """Sum ``nbytes`` from every ready queue; None when none is ready."""
        if nbytes <= 0 or not self._buffers:
            return None
        out: bytes | None = None
        for key, buf in self._buffers.items():
            if not self._primed[key]:
                if len(buf) < nbytes * self._prime_frames:
                    continue
                self._primed[key] = True
            if len(buf) < nbytes:
                self._primed[key] = False
                continue
            chunk = bytes(buf[:nbytes])
            del buf[:nbytes]
            out = chunk if out is None else mix_pcm(out, chunk)
        return out

    def remove(self, key: str) -> None:
        self._buffers.pop(key, None)
        self._primed.pop(key, None)

    def clear(self) -> None:
        """Drop queued audio but keep the registered producers."""
        for key, buf in self._buffers.items():
            buf.clear()
            self._primed[key] = False
