"""Listen-only monitor that produces one mixed stream of a call.

Mixes what the far end says (RX) with what this line sends (TX, including
anything bridged in from other lines) into 20 ms frames on the TX clock, so
a listener hears the call the way a silent third party would.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Callable

from .mixing import MixInputs, mix_pcm

if TYPE_CHECKING:
    from .sip_client import SipClient

_LOGGER = logging.getLogger(__name__)

# (pcm s16le mono, sample_rate)
MonitorListener = Callable[[bytes, int], None]


class CallMonitor:
    """Fan a mixed copy of one client's call audio out to listeners.

    Taps are only attached while somebody is listening, so an idle monitor
    costs nothing on the audio path.
    """

    def __init__(self, client: SipClient) -> None:
        self._client = client
        self._listeners: list[MonitorListener] = []
        self._rx = MixInputs(max_frames=10, prime_frames=2)
        self._attached = False

    @property
    def listening(self) -> bool:
        return bool(self._listeners)

    def add_listener(self, listener: MonitorListener) -> Callable[[], None]:
        self._listeners.append(listener)
        if not self._attached:
            self._client.add_rx_tap(self._on_rx)
            self._client.add_tx_tap(self._on_tx)
            self._attached = True

        def _remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)
            if not self._listeners and self._attached:
                self._client.remove_rx_tap(self._on_rx)
                self._client.remove_tx_tap(self._on_tx)
                self._rx.remove("rx")
                self._attached = False

        return _remove

    def _on_rx(self, pcm_le: bytes) -> None:
        self._rx.push("rx", pcm_le, self._client.codec.pcm_frame_bytes)

    def _on_tx(self, _local: bytes | None, sent: bytes | None) -> None:
        codec = self._client.codec
        frame_bytes = codec.pcm_frame_bytes
        rx = self._rx.pop(frame_bytes)
        if sent is not None and rx is not None:
            frame = mix_pcm(sent, rx)
        elif sent is not None:
            frame = sent
        elif rx is not None:
            frame = rx
        else:
            frame = b"\x00" * frame_bytes
        for listener in list(self._listeners):
            try:
                listener(frame, codec.sample_rate)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Call monitor listener error")
