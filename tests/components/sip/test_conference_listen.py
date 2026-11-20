"""Conference bridging, listen-in monitoring and listen-while-speaking."""

from __future__ import annotations

import array
import base64
from unittest.mock import MagicMock

import pytest

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError

from custom_components.sip.const import DOMAIN
from custom_components.sip.sip_client.bridge import CallBridge
from custom_components.sip.sip_client.mixing import MixInputs, mix_pcm, resample_pcm
from custom_components.sip.sip_client.monitor import CallMonitor

from .common import _assist_ctx, audio, phone_line, sip_client


def _pcm(value: int, samples: int = 160) -> bytes:
    return array.array("h", [value] * samples).tobytes()


def _first(pcm: bytes) -> int:
    return array.array("h", pcm[:2])[0]


def _client() -> sip_client.SipClient:
    client = sip_client.SipClient(sip_client.SipConfig(server="pbx.example"))
    client.state = sip_client.SipState.IN_CALL
    client.rtp._transport = MagicMock()
    return client


def test_mix_pcm_adds_and_saturates():
    assert _first(mix_pcm(_pcm(100), _pcm(23))) == 123
    assert _first(mix_pcm(_pcm(30000), _pcm(30000))) == 32767
    assert _first(mix_pcm(_pcm(-30000), _pcm(-30000))) == -32768
    assert len(mix_pcm(_pcm(1, 160), _pcm(1, 80))) == 320


def test_resample_between_codec_rates():
    assert len(resample_pcm(_pcm(5, 160), 8000, 16000)) == 640
    assert len(resample_pcm(_pcm(5, 320), 16000, 8000)) == 320
    assert _first(resample_pcm(_pcm(5, 160), 8000, 16000)) == 5
    assert resample_pcm(_pcm(5), 8000, 8000) == _pcm(5)


def test_mix_inputs_primes_sums_and_caps():
    mix = MixInputs(max_frames=4, prime_frames=2)
    mix.push("a", _pcm(10), 320)
    assert mix.pop(320) is None  # not primed yet
    mix.push("a", _pcm(10), 320)
    mix.push("b", _pcm(1), 320)
    mix.push("b", _pcm(1), 320)
    assert _first(mix.pop(320)) == 11
    for _ in range(10):
        mix.push("a", _pcm(10), 320)
    assert len(mix._buffers["a"]) == 4 * 320
    mix.remove("a")
    mix.remove("b")
    assert not mix


async def test_bridge_forwards_far_end_and_local_audio_both_ways():
    a, b = _client(), _client()
    heard_by_a_sink: list[bytes] = []

    class _Sink(audio.AudioSink):
        def write(self, pcm_le: bytes) -> None:
            heard_by_a_sink.append(pcm_le)

    a.add_sink(_Sink())
    bridge = CallBridge(a, b)
    bridge.start()

    # B's far end speaks: A's far end and A's sinks (Assist) must hear it.
    for _ in range(3):
        b._on_rx_audio(_pcm(200))
    assert _first(a.rtp._tx_mix.pop(320)) == 200
    for _ in range(2):
        a._on_rx_audio(_pcm(7))
    assert any(_first(chunk) == 207 for chunk in heard_by_a_sink)

    # A's far end reached B's TX mix, but never loops back to A.
    assert _first(b.rtp._tx_mix.pop(320)) == 7
    while (left := a.rtp._tx_mix.pop(320)) is not None:
        assert _first(left) == 200

    # What A plays locally (Assist's voice) is sent to B's far end too.
    for _ in range(2):
        a._on_tx_frame(_pcm(50), _pcm(50))
    # (mixed with the frame of A's far end still queued for B: 50 + 7)
    assert _first(b.rtp._tx_mix.pop(320)) == 57

    bridge.stop()
    b._on_rx_audio(_pcm(200))
    b._on_rx_audio(_pcm(200))
    assert not a.rtp._tx_mix
    assert not a._rx_taps and not b._tx_taps


async def test_bridge_rejects_same_line():
    a = _client()
    with pytest.raises(ValueError):
        CallBridge(a, a)


async def test_monitor_mixes_both_directions_and_detaches():
    client = _client()
    monitor = CallMonitor(client)
    frames: list[tuple[bytes, int]] = []
    remove = monitor.add_listener(lambda pcm, rate: frames.append((pcm, rate)))

    client._on_tx_frame(None, None)
    assert frames[-1] == (b"\x00" * 320, 8000)

    client._on_rx_audio(_pcm(40))
    client._on_rx_audio(_pcm(40))
    client._on_tx_frame(_pcm(2), _pcm(2))
    assert _first(frames[-1][0]) == 42

    remove()
    assert not client._rx_taps and not client._tx_taps
    assert not monitor.listening


def _overlap_bridge(assist_mod, **kwargs):
    stop_calls: list[bool] = []
    bridge = assist_mod.AssistBridge(
        MagicMock(),
        play_source_fn=MagicMock(),
        on_done_fn=MagicMock(),
        stop_audio_fn=lambda *, flush=False: stop_calls.append(flush),
        **kwargs,
    )
    bridge._speaking = True
    return bridge, stop_calls


def test_listen_while_speaking_keeps_reply_and_captures_caller():
    assist_mod, _, _, _ = _assist_ctx()
    original_min = assist_mod._VAD_MIN_SPEECH_FRAMES
    original_micro_vad = assist_mod.MicroVad
    assist_mod._VAD_MIN_SPEECH_FRAMES = 2

    class _StubVad:
        def Process10ms(self, frame: bytes) -> float:
            return 0.9

    assist_mod.MicroVad = lambda: _StubVad()
    try:
        bridge, stop_calls = _overlap_bridge(assist_mod, listen_while_speaking=True)
        frame = b"\x00\x01" * (assist_mod._VAD_FRAME_BYTES // 2)
        for _ in range(5):
            bridge.write(frame)
        # The reply is neither stopped nor is the playback wait released...
        assert stop_calls == []
        assert not bridge._tx_done.is_set()
        # ...but what the caller said is held for the next turn,
        assert bridge._overlap_capture and bridge._post_barge_in_capture
        assert bridge._barge_in_preroll
        # and everything said for the rest of the reply is kept as well.
        for _ in range(400):
            bridge.write(frame)
        assert len(bridge._ring_buffer) > assist_mod._PREROLL_MAX_BYTES
        assert len(bridge._ring_buffer) <= assist_mod._OVERLAP_CAPTURE_MAX_BYTES
        preroll = bridge._take_preroll()
        assert len(preroll) > assist_mod._PREROLL_MAX_BYTES
        assert not bridge._overlap_capture
    finally:
        assist_mod._VAD_MIN_SPEECH_FRAMES = original_min
        assist_mod.MicroVad = original_micro_vad


def test_listen_while_speaking_ignores_noise():
    assist_mod, _, _, _ = _assist_ctx()
    original_micro_vad = assist_mod.MicroVad

    class _NoiseVad:
        def Process10ms(self, frame: bytes) -> float:
            return 0.1

    assist_mod.MicroVad = lambda: _NoiseVad()
    try:
        bridge, stop_calls = _overlap_bridge(assist_mod, listen_while_speaking=True)
        frame = b"\x10\x20" * (assist_mod._VAD_FRAME_BYTES // 2)
        for _ in range(200):
            bridge.write(frame)
        assert stop_calls == []
        assert not bridge._overlap_capture
        assert not bridge._barge_in_preroll
    finally:
        assist_mod.MicroVad = original_micro_vad


async def test_bridge_service_needs_two_lines_in_call(
    hass: HomeAssistant, init_integration
) -> None:
    assert hass.services.has_service(DOMAIN, "bridge")
    assert hass.services.has_service(DOMAIN, "unbridge")
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN, "bridge", phone_line(hass, init_integration), blocking=True
        )
    await hass.services.async_call(
        DOMAIN, "unbridge", phone_line(hass, init_integration), blocking=True
    )


async def test_listen_websocket_streams_call_audio(
    hass: HomeAssistant, init_integration, hass_ws_client
) -> None:
    ws = await hass_ws_client(hass)
    entity_id = phone_line(hass, init_integration)["entity_id"]
    await ws.send_json({"id": 1, "type": "sip/listen", "entity_id": entity_id})
    result = await ws.receive_json()
    assert result["success"]

    client = init_integration.runtime_data["client"]
    assert client._tx_taps
    client._on_tx_frame(_pcm(9), _pcm(9))
    client._on_tx_frame(_pcm(9), _pcm(9))
    event = await ws.receive_json()
    assert event["event"]["rate"] == 8000
    pcm = base64.b64decode(event["event"]["pcm"])
    assert len(pcm) == 640 and _first(pcm) == 9

    await ws.send_json({"id": 2, "type": "unsubscribe_events", "subscription": 1})
    assert (await ws.receive_json())["success"]
    assert not client._tx_taps

    await ws.send_json({"id": 3, "type": "sip/listen", "entity_id": "sensor.nope"})
    assert not (await ws.receive_json())["success"]
