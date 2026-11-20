# Scam Bot call card

`scam-bot-transcript-card.js` is the dashboard card used to run Scam Bot calls: an
Assist persona on hass-sip phone lines that keeps phone scammers talking.

It puts everything for one or more lines in one card:

- **One tab per phone line.** Each tab shows that line's calls as a chat, built from the
  Scam Bot pipeline's debug runs. The tab also shows the other party's number.
- **Idle line:** fields for the number, the reason for calling and phone menu keys, plus a
  **Call** button. **From screenshot / email** reads a scam screenshot, PDF or email with
  an AI task and fills in the number and reason.
- **Line in a call:** a text box to send the bot a private instruction (Enter or **Send**;
  the keyboard stays open between sends), **End call** (tap twice), and **Conference**
  (call another number into the call, merge lines, split lines).
- **Listen in / Stop listening:** plays the selected line in the browser (`sip/listen`)
  and follows the tab you switch to.
- **Hearing now:** live captions from `sip.start_transcription`, when they are on.

## Install

1. Copy the file to `/config/www/scam-bot-transcript-card.js`.
2. Add it as a dashboard resource: Settings > Dashboards > ⋮ > Resources >
   **Add resource**, URL `/local/scam-bot-transcript-card.js`, type **JavaScript module**.
3. Add the card to a dashboard (a panel view suits it):

```yaml
type: custom:scam-bot-transcript-card
pipeline_id: 01m7nq83cs796fvwt4v02en2p7   # the Scam Bot Assist pipeline
lines:
  - name: Line 1
    player: media_player.sip_4_phone_line
    active: binary_sensor.sip_4_call_active
  - name: Line 2
    player: media_player.sip_5_phone_line
    active: binary_sensor.sip_5_call_active
```

Reading the transcript uses the Assist pipeline debug API, so the card needs an admin user.

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `pipeline_id` | (required) | Assist pipeline the bot runs on. |
| `lines` | | `name`, `player` (the line's media player), `active` (its call-active binary sensor). |
| `max_calls` | `3` | Calls shown per tab. |
| `interval` | `2` | Seconds between transcript refreshes. |
| `call_script` | `script.scam_bot_call_number` | Started by **Call** with `number`, `scam_type`, `menu_keys`, `player`. |
| `send_script` | `script.scam_bot_send_instruction` | Run by **Send** with `line` (the player). |
| `add_script` | `script.scam_bot_add_number` | Run by **Call and add** with `number`. |
| `instruction_entity` | `input_text.scam_bot_live_instruction` | Holds the instruction being sent. |
| `number_entity` | `input_text.scam_bot_number` | Kept in step with the number field. |
| `reason_entity` | `input_text.scam_bot_scam_type` | Kept in step with the reason field. |
| `keys_entity` | `input_text.scam_bot_menu_keys` | Kept in step with the menu keys field. |
| `ai_task_entity` | `ai_task.claude_ai_task_2` | AI task used by **From screenshot / email**. |

The scripts and helpers are your own. The card only calls them, so their names can be
changed with the options above.

## How tabs find their calls

The card groups pipeline runs by `conversation_id` and puts a conversation on a tab when
the id contains that line's media player object id, for example
`scambot_sip_4_phone_line_20261120_125001_4821`. Give each call's `sip.start_assist` a
`conversation_id` like that. Conversations without a line in the id show on every tab.

## Scanning PDFs

PDF text is read in the browser with pdf.js, loaded from jsDelivr
(`pdfjs-dist@4.10.38`). A scanned PDF with no text is sent as a picture of page 1.
Images are uploaded to the local media folder for the AI task and removed afterwards.
