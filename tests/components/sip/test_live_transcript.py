"""Live captions: phrase segmentation, STT hand-off and Assist integration."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from homeassistant.components import stt
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError

from custom_components.sip import live_transcript
from custom_components.sip.const import DOMAIN, EVENT_SIP_LIVE_TRANSCRIPT

from .common import _assist_ctx, phone_line

SPEECH = b"\x10\x27" * 160  # loud 10 ms @ 16 kHz
SILENCE = b"\x00\x00" * 160


class _EnergyVad:
    def Process10ms(self, frame: bytes) -> float:
        return 0.9 if frame[1] else 0.0


class _SttEntity:
    def __init__(self, text: str = "hello there") -> None:
        self.text = text
        self.calls: list[int] = []

    async def internal_async_process_audio_stream(self, metadata, stream):
        size = 0
        async for chunk in stream:
            size += len(chunk)
        self.calls.append(size)
        return SimpleNamespace(text=self.text, result=stt.SpeechResultState.SUCCESS)


def _transcriber(hass, heard, **kwargs):
    with patch.object(live_transcript, "MicroVad", _EnergyVad):
        return live_transcript.LiveTranscriber(
            hass, "stt.test", "en", heard.append, sample_rate=16000, **kwargs
        )


async def test_phrase_is_cut_at_a_pause_and_transcribed(hass: HomeAssistant) -> None:
    heard: list[str] = []
    entity = _SttEntity()
    transcriber = _transcriber(hass, heard)
    with patch.object(stt, "async_get_speech_to_text_entity", return_value=entity):
        transcriber.feed(SILENCE * 20 + SPEECH * 50)
        assert not entity.calls  # still talking
        transcriber.feed(SILENCE * 60)
        await asyncio.wait_for(transcriber._task, 2)
    assert heard == ["hello there"]
    # 50 speech frames + up to 300 ms of lead-in + the 600 ms pause
    assert entity.calls[0] >= (50 + 60) * 320
    transcriber.close()


async def test_noise_blips_and_closed_transcriber_send_nothing(
    hass: HomeAssistant,
) -> None:
    heard: list[str] = []
    entity = _SttEntity()
    transcriber = _transcriber(hass, heard)
    with patch.object(stt, "async_get_speech_to_text_entity", return_value=entity):
        transcriber.feed(SPEECH * 8 + SILENCE * 70)  # 80 ms blip
        assert transcriber._task is None
        transcriber.close()
        transcriber.feed(SPEECH * 50 + SILENCE * 70)
    assert not heard and not entity.calls


async def test_long_speech_is_split_at_the_maximum(hass: HomeAssistant) -> None:
    heard: list[str] = []
    entity = _SttEntity()
    transcriber = _transcriber(hass, heard, max_phrase_seconds=1.0)
    with patch.object(stt, "async_get_speech_to_text_entity", return_value=entity):
        transcriber.feed(SPEECH * 250)
        await asyncio.wait_for(transcriber._task, 2)
    assert len(heard) >= 2
    transcriber.close()


def _bridge(assist_mod, **kwargs):
    stop_calls: list[bool] = []
    bridge = assist_mod.AssistBridge(
        MagicMock(),
        play_source_fn=MagicMock(),
        on_done_fn=MagicMock(),
        stop_audio_fn=lambda *, flush=False: stop_calls.append(flush),
        system_prompt="Be Margaret.",
        **kwargs,
    )
    return bridge, stop_calls


def test_captions_over_a_reply_reach_the_next_turn_as_text():
    assist_mod, _, _, _ = _assist_ctx()
    bridge, _ = _bridge(assist_mod)
    bridge._listening = True
    assert bridge.on_live_caption("what the turn hears anyway") is False
    assert bridge._turn_system_prompt() == "Be Margaret."

    bridge._listening = False
    bridge._speaking = True
    assert bridge.on_live_caption("wait, which card?") is True
    prompt = bridge._turn_system_prompt()
    assert prompt.startswith("Be Margaret. LIVE CAPTIONS")
    assert "wait, which card?" in prompt
    assert bridge._turn_system_prompt() == "Be Margaret."  # used once


def test_interrupt_on_words_stops_the_reply_only_for_enough_words():
    assist_mod, _, _, _ = _assist_ctx()
    bridge, stop_calls = _bridge(assist_mod, interrupt_on_words=5)
    bridge._speaking = True
    bridge.on_live_caption("uh huh")
    assert stop_calls == [] and not bridge._tx_done.is_set()
    bridge.on_live_caption("no listen to me ma'am")
    assert stop_calls == [True]
    assert bridge._tx_done.is_set() and bridge._post_barge_in_capture

    quiet, quiet_stops = _bridge(assist_mod)  # default: never interrupt
    quiet._speaking = True
    quiet.on_live_caption("one two three four five six seven")
    assert quiet_stops == []


async def test_transcription_service_fires_events_and_feeds_get_transcript(
    hass: HomeAssistant, init_integration
) -> None:
    target = phone_line(hass, init_integration)
    with pytest.raises(ServiceValidationError):  # no call yet
        await hass.services.async_call(
            DOMAIN,
            "start_transcription",
            {**target, "stt_engine": "stt.test"},
            blocking=True,
        )

    data = init_integration.runtime_data
    events = []
    hass.bus.async_listen(EVENT_SIP_LIVE_TRANSCRIPT, events.append)
    data["start_transcription_fn"]("stt.test", "en")
    client = data["client"]
    assert client._rx_taps
    # deliver one caption the way the transcriber does
    [tap] = client._rx_taps
    tap.__self__.on_text("Hello ma'am")
    await hass.async_block_till_done()
    assert events[0].data["text"] == "Hello ma'am"
    assert events[0].data["entry_id"] == init_integration.entry_id

    result = await hass.services.async_call(
        DOMAIN, "get_transcript", target, blocking=True, return_response=True
    )
    assert [c["text"] for c in result["captions"]] == ["Hello ma'am"]

    await hass.services.async_call(DOMAIN, "stop_transcription", target, blocking=True)
    assert not client._rx_taps
