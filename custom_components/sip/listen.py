"""Live listen-in: stream a call's mixed audio to a dashboard card.

A websocket subscription (``sip/listen``) delivers the call as small PCM
chunks; ``frontend/sip-listen-card.js`` plays them with WebAudio. The stream
is listen-only: nothing the browser does reaches the call.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN, LOGGER
from .sip_client.monitor import CallMonitor

CARD_FILENAME = "sip-listen-card.js"
CARD_URL = f"/{DOMAIN}_static/{CARD_FILENAME}"
_DATA_SETUP = f"{DOMAIN}_listen_setup"
# 20 ms frames are sent in pairs: 25 messages a second per listener.
_FRAMES_PER_MESSAGE = 2


async def async_setup_listen(hass: HomeAssistant) -> None:
    """Register the websocket command and serve the card (once per HA run)."""
    if hass.data.get(_DATA_SETUP):
        return
    hass.data[_DATA_SETUP] = True
    websocket_api.async_register_command(hass, ws_listen)

    if getattr(hass, "http", None) is None:
        return
    try:
        from homeassistant.components.http import StaticPathConfig

        card_path = Path(__file__).parent / "frontend" / CARD_FILENAME
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(card_path), False)]
        )
        from homeassistant.components import frontend

        frontend.add_extra_js_url(hass, CARD_URL)
    except Exception as err:  # noqa: BLE001 - the card is optional
        LOGGER.warning("Could not register the SIP listen card: %s", err)


def _entry_data_for_entity(
    hass: HomeAssistant, entity_id: str
) -> dict[str, Any] | None:
    reg_entry = er.async_get(hass).async_get(entity_id)
    if reg_entry is None or reg_entry.platform != DOMAIN:
        return None
    entry = hass.config_entries.async_get_entry(reg_entry.config_entry_id or "")
    if entry is None or entry.domain != DOMAIN or entry.state.value != "loaded":
        return None
    return entry.runtime_data


def get_monitor(entry_data: dict[str, Any]) -> CallMonitor:
    monitor = entry_data.get("monitor")
    if monitor is None:
        monitor = entry_data["monitor"] = CallMonitor(entry_data["client"])
    return monitor


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sip/listen",
        vol.Required("entity_id"): cv.entity_id,
    }
)
@websocket_api.require_admin
@callback
def ws_listen(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Subscribe to the audio of one phone line (admins only)."""
    entry_data = _entry_data_for_entity(hass, msg["entity_id"])
    if entry_data is None or entry_data.get("client") is None:
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, "Not a loaded SIP phone line"
        )
        return

    msg_id = msg["id"]
    pending = bytearray()
    state = {"frames": 0, "rate": 0}

    @callback
    def _on_audio(pcm_le: bytes, rate: int) -> None:
        if state["rate"] != rate:
            pending.clear()
            state["frames"] = 0
            state["rate"] = rate
        pending.extend(pcm_le)
        state["frames"] += 1
        if state["frames"] < _FRAMES_PER_MESSAGE:
            return
        payload = base64.b64encode(bytes(pending)).decode("ascii")
        pending.clear()
        state["frames"] = 0
        connection.send_message(
            websocket_api.event_message(msg_id, {"rate": rate, "pcm": payload})
        )

    connection.subscriptions[msg_id] = get_monitor(entry_data).add_listener(_on_audio)
    connection.send_result(msg_id)
