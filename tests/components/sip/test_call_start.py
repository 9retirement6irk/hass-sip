"""Words said at pickup reach the first Assist turn; caller speech is exposed."""

from __future__ import annotations

from collections.abc import Generator
from unittest.mock import MagicMock, patch

import pytest

from homeassistant.core import Context, HomeAssistant

from custom_components.sip.assist import CallStartBuffer
from custom_components.sip.const import DOMAIN

from .common import _assist_ctx, phone_line


def test_call_start_buffer_keeps_only_the_latest_audio() -> None:
    buf = CallStartBuffer(max_bytes=6)
    buf.write(b"abcd")
    buf.write(b"efgh")
    assert buf.take() == b"cdefgh"
    assert buf.take() == b""


def _bridge(assist_mod, **kwargs):
    return assist_mod.AssistBridge(
        MagicMock(),
        play_source_fn=MagicMock(),
        on_done_fn=MagicMock(),
        stop_audio_fn=lambda *, flush=False: None,
        sample_rate=16000,
        **kwargs,
    )


def test_seeded_audio_starts_the_first_turn() -> None:
    assist_mod, _, _, _ = _assist_ctx()
    bridge = _bridge(assist_mod)
    bridge.seed_preroll(b"\x01\x02" * 800)
    assert bridge._take_preroll() == b"\x01\x02" * 800
    # used once
    assert bridge._take_preroll() == b""


def test_caller_speech_is_reported() -> None:
    assist_mod, _, PET, PE = _assist_ctx()
    heard: list[bool] = []
    bridge = _bridge(assist_mod, on_speech_fn=lambda: heard.append(True))
    bridge._running = True
    bridge._on_pipeline_event(PE(PET.STT_VAD_START, {}))
    assert heard == [True]
    bridge._on_pipeline_event(PE(PET.STT_END, {"stt_output": {"text": "  "}}))
    assert heard == [True]
    bridge._on_pipeline_event(PE(PET.STT_END, {"stt_output": {"text": "hello?"}}))
    assert heard == [True, True]


@pytest.fixture
def assist_bridge() -> Generator[MagicMock]:
    with patch("custom_components.sip.AssistBridge") as bridge_cls:
        yield bridge_cls


async def _start(hass, entry, **data) -> None:
    await hass.services.async_call(
        DOMAIN,
        "start_assist",
        {**phone_line(hass, entry), **data},
        blocking=True,
        context=Context(),
    )


async def test_include_call_start_hands_pickup_audio_to_assist(
    hass: HomeAssistant, init_integration, assist_bridge: MagicMock
) -> None:
    entry = init_integration
    client = entry.runtime_data["client"]
    entry.runtime_data["call_number"] = "100"
    client.cb.on_call_connected()
    client.sink.write(b"\x05\x00" * 400)  # "Hello?" at pickup

    await _start(hass, entry, include_call_start=True)
    assist_bridge.return_value.seed_preroll.assert_called_once_with(b"\x05\x00" * 400)
    assert "call_start_buffer" not in entry.runtime_data

    # a second Assist on the same call does not hear it again
    assist_bridge.reset_mock()
    await _start(hass, entry, include_call_start=True)
    assist_bridge.return_value.seed_preroll.assert_not_called()


async def test_call_start_audio_is_dropped_without_the_option(
    hass: HomeAssistant, init_integration, assist_bridge: MagicMock
) -> None:
    entry = init_integration
    client = entry.runtime_data["client"]
    entry.runtime_data["call_number"] = "100"
    client.cb.on_call_connected()
    client.sink.write(b"\x05\x00" * 400)

    await _start(hass, entry)
    assist_bridge.return_value.seed_preroll.assert_not_called()
    assert "call_start_buffer" not in entry.runtime_data


async def test_caller_heard_at_is_on_the_phone_line(
    hass: HomeAssistant, init_integration, assist_bridge: MagicMock
) -> None:
    entry = init_integration
    entry.runtime_data["call_number"] = "100"
    entry.runtime_data["client"].cb.on_call_connected()
    await _start(hass, entry)
    on_speech = assist_bridge.call_args.kwargs["on_speech_fn"]
    on_speech()
    await hass.async_block_till_done()
    state = hass.states.get(phone_line(hass, entry)["entity_id"])
    assert state.attributes["caller_heard_at"]
