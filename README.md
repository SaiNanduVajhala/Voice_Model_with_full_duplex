# Real-Time Emotion-Aware Multimodal Voice Assistant

A low-latency, full-duplex AI voice assistant that runs entirely within the browser's free-tier constraints. It uses the Web Speech API for transcription, `face-api.js` for local facial emotion recognition, and `llama-3.1-8b-instant` (via Groq) for rapid, emotionally responsive conversational intelligence.

## Features
- **Zero-Cost Architecture**: Utilizes free browser APIs, public model CDNs, Edge TTS, and Groq's free tier.
- **Real-Time Emotion Tracking**: Uses `face-api.js` directly in the browser to detect the user's emotion at 1 FPS. No video data is ever sent to the server.
- **Dynamic Persona Adaptation**: The AI actively adjusts its system prompt mid-conversation based on your latest facial expression (e.g., matching enthusiasm or showing empathy).
- **Ultra-Low Latency & Barge-In**: WebSockets stream audio chunks instantaneously from the server, and the frontend instantly halts playback the millisecond the user interrupts.

## Setup Instructions

### Prerequisites
- Python 3.9+
- A [Groq API Key (Free)](https://console.groq.com/keys)

### 1. Backend Setup
1. Open a terminal and navigate to the `backend` folder:
   ```bash
   cd backend
   ```
2. Create a virtual environment and install the dependencies:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate  # Windows
   pip install -r requirements.txt
   ```
3. Create a `.env` file in the `backend` folder and add your Groq API key:
   ```ini
   GROQ_API_KEY=gsk_your_api_key_here
   ```
4. Start the backend WebSocket server:
   ```bash
   python -m uvicorn main:app --reload
   ```

### 2. Frontend Setup
Browser security policies require webcam feeds and AudioContexts to be served over `localhost` or HTTPS.

1. Open a *new* terminal and navigate to the `frontend` folder:
   ```bash
   cd frontend
   ```
2. Start a simple local server:
   ```bash
   python -m http.server 8080
   ```
3. Open your browser and navigate to: **[http://localhost:8080](http://localhost:8080)**

## Architecture
- **Frontend**: HTML5, Vanilla JavaScript, CSS3.
- **Backend**: FastAPI, `websockets`, `edge-tts`, `AsyncGroq`.
- **Vision**: `face-api.js` (tinyFaceDetector, faceExpressionNet).
- **LLM**: `llama-3.1-8b-instant`.
