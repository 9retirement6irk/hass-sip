"""Live captions: transcribe the far end of a call phrase by phrase.

Independent of Assist turns. The caller's audio is cut into phrases at
pauses and each phrase is sent to a speech-to-text entity as soon as it
ends, so what they say is known even while a reply is being spoken.
"""

from __future__ import annotations

import array
import asyncio
from collections import deque
from collections.abc import AsyncIterable, Callable

from homeassistant.components import stt
from homeassistant.core import HomeAssistant

from .const import LOGGER
from .sip_client.mixing import resample_pcm

try:
    from pymicro_vad import MicroVad
except ImportError:  # pragma: no cover - optional dependency
    MicroVad = None  # type: ignore[misc, assignment]

_RATE = 16000
_FRAME_BYTES = 320  # 10 ms @ 16 kHz s16le mono
_SPEECH_THRESHOLD = 0.5
_ENERGY_THRESHOLD = 700  # mean |sample| fallback when MicroVad is missing
_START_FRAMES = 6  # 60 ms of speech opens a phrase
_PREBUFFER_FRAMES = 30  # 300 ms kept from before the phrase opened
_MIN_SPEECH_FRAMES = 25  # ignore phrases with under 250 ms of speech
_QUEUE_MAX = 8

# (text) -> None
CaptionListener = Callable[[str], None]


class LiveTranscriber:
    """Segment call audio at pauses and transcribe each phrase."""

    def __init__(
        self,
        hass: HomeAssistant,
        stt_engine: str,
        language: str,
        on_text: CaptionListener,
        *,
        sample_rate: int = 8000,
        silence_seconds: float = 0.6,
        max_phrase_seconds: float = 15.0,
    ) -> None:
        self.hass = hass
        self.stt_engine = stt_engine
        self.language = language
        self.on_text = on_text
        self.sample_rate = sample_rate
        self._silence_frames = max(10, int(silence_seconds * 100))
        self._max_frames = max(100, int(max_phrase_seconds * 100))
        self._vad = MicroVad() if MicroVad is not None else None
        self._pending = bytearray()
        self._prebuffer: deque[bytes] = deque(maxlen=_PREBUFFER_FRAMES)
        self._phrase = bytearray()
        self._in_phrase = False
        self._run = 0  # consecutive speech frames while idle
        self._quiet = 0  # consecutive non-speech frames inside a phrase
        self._speech_frames = 0
        self._frames = 0
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._closed = False

    # -- audio in ---------------------------------------------------------
    def feed(self, pcm_le: bytes) -> None:
        """Take far-end PCM at the call's sample rate (event loop only)."""
        if self._closed or not pcm_le:
            return
        self._pending.extend(resample_pcm(pcm_le, self.sample_rate, _RATE))
        while len(self._pending) >= _FRAME_BYTES:
            frame = bytes(self._pending[:_FRAME_BYTES])
            del self._pending[:_FRAME_BYTES]
            self._on_frame(frame, self._is_speech(frame))

    def _is_speech(self, frame: bytes) -> bool:
        if self._vad is not None:
            return self._vad.Process10ms(frame) >= _SPEECH_THRESHOLD
        samples = array.array("h", frame)
        return sum(abs(s) for s in samples) / len(samples) >= _ENERGY_THRESHOLD

    def _on_frame(self, frame: bytes, speech: bool) -> None:
        if not self._in_phrase:
            self._prebuffer.append(frame)
            self._run = self._run + 1 if speech else 0
            if self._run >= _START_FRAMES:
                self._in_phrase = True
                self._phrase = bytearray(b"".join(self._prebuffer))
                self._prebuffer.clear()
                self._frames = len(self._phrase) // _FRAME_BYTES
                self._speech_frames = self._run
                self._quiet = 0
                self._run = 0
            return
        self._phrase.extend(frame)
        self._frames += 1
        if speech:
            self._speech_frames += 1
            self._quiet = 0
        else:
            self._quiet += 1
        if self._quiet >= self._silence_frames or self._frames >= self._max_frames:
            self._finish_phrase()

    def _finish_phrase(self) -> None:
        pcm = bytes(self._phrase)
        enough = self._speech_frames >= _MIN_SPEECH_FRAMES
        self._phrase = bytearray()
        self._in_phrase = False
        self._frames = 0
        self._speech_frames = 0
        self._quiet = 0
        if not enough:
            return
        while self._queue.qsize() >= _QUEUE_MAX:
            self._queue.get_nowait()  # STT is behind: drop the oldest phrase
        self._queue.put_nowait(pcm)
        if self._task is None or self._task.done():
            self._task = self.hass.async_create_background_task(
                self._worker(), "sip live transcription"
            )

    # -- speech to text ---------------------------------------------------
    async def _worker(self) -> None:
        while not self._closed and not self._queue.empty():
            pcm = self._queue.get_nowait()
            try:
                text = await self._transcribe(pcm)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                LOGGER.exception("Live transcription failed")
                continue
            if text and not self._closed:
                try:
                    self.on_text(text)
                except Exception:  # noqa: BLE001
                    LOGGER.exception("Live transcription listener failed")

    async def _transcribe(self, pcm: bytes) -> str:
        entity = stt.async_get_speech_to_text_entity(self.hass, self.stt_engine)
        if entity is None:
            LOGGER.warning("Live transcription: no STT entity %s", self.stt_engine)
            return ""
        metadata = stt.SpeechMetadata(
            language=self.language,
            format=stt.AudioFormats.WAV,
            codec=stt.AudioCodecs.PCM,
            bit_rate=stt.AudioBitRates.BITRATE_16,
            sample_rate=stt.AudioSampleRates.SAMPLERATE_16000,
            channel=stt.AudioChannels.CHANNEL_MONO,
        )

        async def _stream() -> AsyncIterable[bytes]:
            for start in range(0, len(pcm), 4096):
                yield pcm[start : start + 4096]

        async with asyncio.timeout(20):
            result = await entity.internal_async_process_audio_stream(
                metadata, _stream()
            )
        if result.result != stt.SpeechResultState.SUCCESS or not result.text:
            return ""
        return result.text.strip()

    def close(self) -> None:
        self._closed = True
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
