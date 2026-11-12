# Vbee MCP server

MCP server that gives Claude Code, Claude Desktop and Cursor the [Vbee](https://studio.vbee.vn/apps) API: Vietnamese text-to-speech for voiceovers and speech-to-text for timed captions in HyperFrames videos.

## Tools

| Tool                   | What it does                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vbee_list_voices`     | Lists voices (code, name, gender, language, demo link). Filter by language, gender, ownership (`VBEE`, `COMMUNITY`, `PERSONAL`).                                                                                                                                                       |
| `vbee_text_to_speech`  | Reads up to 100,000 characters with a voice, waits for Vbee, and saves the MP3/WAV. With `project`, a relative path lands in `D:\HyperFrames Projects\<project>\` (default `assets/voice/vbee-<requestId>.mp3`). Speed, bitrate, sample rate, emphasis and pause lengths are optional. |
| `vbee_get_tts_request` | Status and a fresh audio link for an earlier request (links expire after 3 minutes, audio is kept 3 days); can download it again.                                                                                                                                                      |
| `vbee_speech_to_text`  | Transcribes a WAV file or URL (< 100 MB), returns the transcript and timed utterances, and can write an `.srt`.                                                                                                                                                                        |

## Setup

1. Create an app at <https://studio.vbee.vn/apps> (Tích hợp API → Tạo ứng dụng) and copy its App ID and token. Tokens expire on the date you pick; choose "Vĩnh viễn" to avoid renewing.
2. Install and add the credentials:

   ```bash
   cd mcp/vbee
   npm install
   cp .env.example .env   # then fill in VBEE_APP_ID and VBEE_TOKEN
   ```

3. Register the server:

   ```bash
   claude mcp add vbee -s user -- node "<absolute path>/mcp/vbee/server.mjs"
   ```

   Or in any MCP client config (credentials may go in `env` instead of `.env`):

   ```json
   {
     "mcpServers": {
       "vbee": {
         "command": "node",
         "args": ["<absolute path>/mcp/vbee/server.mjs"],
         "env": { "VBEE_APP_ID": "...", "VBEE_TOKEN": "..." }
       }
     }
   }
   ```

## Environment

| Variable                    | Default                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `VBEE_APP_ID`, `VBEE_TOKEN` | required                                                         |
| `VBEE_VOICE_CODE`           | `hn_female_ngochuyen_full_48k-fhg` (HN - Ngọc Huyền)             |
| `VBEE_WEBHOOK_URL`          | placeholder; the server polls instead of waiting for the webhook |
| `VBEE_API_BASE`             | `https://api.vbee.vn`                                            |
| `HYPERFRAMES_PROJECTS_DIR`  | `D:\HyperFrames Projects`                                        |

The token stays local: `.env` is git-ignored and the server sends it only to Vbee.

API reference: <https://api-docs.vbee.vn/llms.txt>
