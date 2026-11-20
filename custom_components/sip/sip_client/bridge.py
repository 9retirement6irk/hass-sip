"""Conference bridge between two calls on two SIP lines.

Each line is its own SIP registration with its own call, so "merging" two
calls means forwarding audio between the two clients:

* what line A hears from its far end is sent to B's far end (and the other
  way round), so the two outside parties hear each other;
* what line A itself plays into its call (TTS, Assist replies, media) is
  also sent to B's far end, so everybody hears the local speaker too;
* B's far end is additionally mixed into what A's sinks hear, so Assist or
  a recorder on one line follows the whole conversation.

Only "raw received" audio and "locally produced" audio are ever forwarded,
never audio that already came across a bridge. That keeps the scheme
loop-free and lets several lines be bridged pairwise into a larger
conference without anyone hearing themselves.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .mixing import resample_pcm

if TYPE_CHECKING:
    from .sip_client import SipClient

_LOGGER = logging.getLogger(__name__)


class _Leg:
    """One direction of a bridge: audio of ``src`` delivered to ``dst``."""

    def __init__(self, src: SipClient, dst: SipClient, key: str) -> None:
        self.src = src
        self.dst = dst
        self.key_rx = f"{key}:rx"
        self.key_tx = f"{key}:tx"

    def _convert(self, pcm_le: bytes) -> bytes:
        return resample_pcm(
            pcm_le, self.src.codec.sample_rate, self.dst.codec.sample_rate
        )

    def on_rx(self, pcm_le: bytes) -> None:
        if not self.dst.in_call:
            return
        pcm = self._convert(pcm_le)
        self.dst.rtp.push_mix_audio(self.key_rx, pcm)
        self.dst.push_rx_mix(self.key_rx, pcm)

    def on_tx(self, local: bytes | None, _sent: bytes | None) -> None:
        if local is None or not self.dst.in_call:
            return
        self.dst.rtp.push_mix_audio(self.key_tx, self._convert(local))

    def attach(self) -> None:
        self.src.add_rx_tap(self.on_rx)
        self.src.add_tx_tap(self.on_tx)

    def detach(self) -> None:
        self.src.remove_rx_tap(self.on_rx)
        self.src.remove_tx_tap(self.on_tx)
        self.dst.rtp.remove_mix_input(self.key_rx)
        self.dst.rtp.remove_mix_input(self.key_tx)
        self.dst.remove_rx_mix(self.key_rx)


class CallBridge:
    """Two-way audio bridge between the active calls of two clients."""

    def __init__(self, a: SipClient, b: SipClient) -> None:
        if a is b:
            raise ValueError("cannot bridge a line with itself")
        self.a = a
        self.b = b
        key = f"bridge:{id(self):x}"
        self._legs = (_Leg(a, b, f"{key}:a"), _Leg(b, a, f"{key}:b"))
        self.active = False

    def involves(self, client: SipClient) -> bool:
        return client is self.a or client is self.b

    def start(self) -> None:
        if self.active:
            return
        for leg in self._legs:
            leg.attach()
        self.active = True
        _LOGGER.info("Call bridge started")

    def stop(self) -> None:
        if not self.active:
            return
        for leg in self._legs:
            leg.detach()
        self.active = False
        _LOGGER.info("Call bridge stopped")
