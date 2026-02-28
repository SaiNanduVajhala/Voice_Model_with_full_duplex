# Real-Time Emotion-Aware Multimodal Voice Assistant

## Overview
Building a free-tier, real-time emotion-aware multimodal voice assistant that runs heavy processing (STT and Facial Emotion Recognition) locally on the client (browser) and uses a FastAPI backend with Groq for fast LLM inference and edge-tts for speech synthesis.

## Project Type
WEB + BACKEND

## Success Criteria
- 100% free API usage (Groq free tier, edge-tts, native browser APIs).
- Face emotion detected locally at 1-2 FPS.
- Continuous Speech-to-Text running in the browser.
- Full-duplex communication with barge-in support.
- Zero raw audio or video frames sent to the server.

## Tech Stack
- **Frontend**: HTML, Vanilla JavaScript, Web Speech API (STT), face-api.js or MediaPipe (Emotion)
- **Backend**: Python, FastAPI, WebSockets
- **LLM**: Groq API (llama3-8b-8192)
- **TTS**: edge-tts (Python)

## File Structure
```text
/
├── backend/
│   ├── main.py
│   └── requirements.txt
└── frontend/
    ├── index.html
    └── app.js
```

## Task Breakdown

### Stage 1: The Client-Side Senses (Browser STT & Vision)
- **Task 1.1**: Setup basic HTML structure and serve frontend files.
  - **Agent**: `frontend-specialist`
  - **INPUT**: Empty directory
  - **OUTPUT**: `index.html` and `app.js` with basic scaffolding.
  - **VERIFY**: Open `index.html` in browser, verify no console errors.
- **Task 1.2**: Implement Web Speech API for continuous STT.
  - **Agent**: `frontend-specialist`
  - **INPUT**: `app.js`
  - **OUTPUT**: JS code handling microphone permissions and STT transcription.
  - **VERIFY**: Speak into microphone, see transcribed text logged in frontend console.
- **Task 1.3**: Integrate face-api.js for emotion detection.
  - **Agent**: `frontend-specialist`
  - **INPUT**: `index.html`, `app.js`
  - **OUTPUT**: Webcam feed rendered, DOM updating with detected emotion at 1 FPS.
  - **VERIFY**: Show different facial expressions, verify dominant emotion updates accurately.
- **Task 1.4**: Setup WebSocket client and payload transmission.
  - **Agent**: `frontend-specialist`
  - **INPUT**: `app.js`
  - **OUTPUT**: WebSocket connection established to backend, sending `{ user_text, visual_context }` on sentence completion.
  - **VERIFY**: View WebSocket frames in browser DevTools to ensure correct JSON payload structure.

### Stage 2: The Brain & Persona (FastAPI + Groq)
- **Task 2.1**: Initialize FastAPI backend and WebSocket endpoint.
  - **Agent**: `backend-specialist`
  - **INPUT**: `backend/main.py`
  - **OUTPUT**: Running FastAPI server accepting WebSocket connections on `/ws`.
  - **VERIFY**: Connect frontend to backend, verify connection open event.
- **Task 2.2**: Integrate Groq API and dynamic prompting.
  - **Agent**: `backend-specialist`
  - **INPUT**: `backend/main.py`
  - **OUTPUT**: Logic to receive WebSocket payload, construct dynamic prompt with `visual_context`, and query `llama3-8b-8192`.
  - **VERIFY**: Send mock WebSocket payload, verify Groq returns a context-aware response.
- **Task 2.3**: Stream text output to client.
  - **Agent**: `backend-specialist`
  - **INPUT**: `backend/main.py`
  - **OUTPUT**: Backend streams text chunks back to frontend over WebSocket.
  - **VERIFY**: Frontend logs received text chunks from the LLM.

### Stage 3: The Voice & Full-Duplex Flow (Edge-TTS & Barge-in)
- **Task 3.1**: Integrate `edge-tts` for audio generation.
  - **Agent**: `backend-specialist`
  - **INPUT**: `backend/main.py`
  - **OUTPUT**: Backend converts Groq text chunks into audio buffers via `edge-tts`.
  - **VERIFY**: Audio chunks are successfully generated and saved to a temp file for testing.
- **Task 3.2**: Stream audio buffers to frontend and handle playback.
  - **Agent**: `frontend-specialist`
  - **INPUT**: `frontend/app.js`, `backend/main.py`
  - **OUTPUT**: Backend sends audio buffers over WS; frontend plays them using Web Audio API.
  - **VERIFY**: User hears the LLM response spoken aloud continuously.
- **Task 3.3**: Implement Barge-In (Interruption) logic.
  - **Agent**: `orchestrator`
  - **INPUT**: `frontend/app.js`, `backend/main.py`
  - **OUTPUT**: Frontend stops audio and sends `{"interrupt": true}` on new speech; backend cancels TTS generation.
  - **VERIFY**: Speak while TTS is playing; verify TTS stops immediately and starts processing new speech.

## Phase X Complete
*Pending verification after implementation.*
