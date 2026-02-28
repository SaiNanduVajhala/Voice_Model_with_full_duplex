// Configuration
const WS_URL = 'ws://localhost:8000/ws';
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/';

// UI Elements
const video = document.getElementById('videoElement');
const canvas = document.getElementById('canvasElement');
const emotionBadge = document.getElementById('emotion-badge');
const transcriptBox = document.getElementById('transcript-box');
const interimTextEl = document.getElementById('interim-text');
const startBtn = document.getElementById('startButton');
const stopBtn = document.getElementById('stopButton');
const wsStatusText = document.getElementById('ws-status-text');
const wsStatusDot = document.getElementById('ws-status-dot');
const voiceOrb = document.getElementById('voice-orb');

// State
let ws = null;
let recognition = null;
let currentEmotion = 'neutral';
let isAssistantActive = false;
let emotionInterval = null;

// --- Audio Playback State (Stage 3) ---
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let activeSource = null;

function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
}

// --- WebSockets ---
function initWebSocket() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer'; // Crucial for receiving raw audio bytes

    ws.onopen = () => {
        console.log('WebSocket Connected');
        wsStatusText.textContent = 'Connected';
        wsStatusDot.classList.add('active');
    };

    ws.onclose = () => {
        console.log('WebSocket Disconnected');
        wsStatusText.textContent = 'Disconnected';
        wsStatusDot.classList.remove('active');
        if (isAssistantActive) {
            setTimeout(initWebSocket, 2000); // Reconnect
        }
    };

    ws.onmessage = async (event) => {
        if (typeof event.data === 'string') {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'text_chunk') {
                    appendOrUpdateAIText(data.text);
                }
            } catch (e) {
                console.log("Received string data:", event.data);
            }
        } else if (event.data instanceof ArrayBuffer) {
            // Stage 3: Received audio chunk
            await handleAudioChunk(event.data);
        }
    };
}

let activeMessageEl = null;

function appendOrUpdateAIText(text) {
    if (!activeMessageEl) {
        activeMessageEl = document.createElement('div');
        activeMessageEl.className = 'message ai-message';
        transcriptBox.appendChild(activeMessageEl);
    }
    activeMessageEl.innerText += text;
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function appendUserText(text) {
    const msg = document.createElement('div');
    msg.className = 'message user-message';
    msg.innerText = text;
    transcriptBox.appendChild(msg);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    activeMessageEl = null; // Reset AI message block so it creates a new one next time
}

// --- Vision (face-api.js) ---
async function initVision() {
    try {
        emotionBadge.textContent = 'Loading Models...';
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
        ]);

        emotionBadge.textContent = 'Starting Camera...';
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = stream;

        // Wait for video to be ready before getting dimensions
        video.addEventListener('loadedmetadata', () => {
            console.log("Webcam ready. Video dimensions:", video.videoWidth, video.videoHeight);
        });

        video.addEventListener('play', () => {
            const displaySize = { width: video.clientWidth || video.videoWidth, height: video.clientHeight || video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);

            emotionInterval = setInterval(async () => {
                if (video.paused || video.ended || !isAssistantActive) return;

                const detections = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceExpressions();
                if (detections) {
                    const resizedDetections = faceapi.resizeResults(detections, displaySize);
                    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

                    const expressions = detections.expressions;
                    const topEmotion = Object.keys(expressions).reduce((a, b) => expressions[a] > expressions[b] ? a : b);
                    currentEmotion = topEmotion;
                    emotionBadge.textContent = `Emotions: ${topEmotion} (${Math.round(expressions[topEmotion] * 100)}%)`;
                } else {
                    currentEmotion = 'none';
                    emotionBadge.textContent = 'No face detected';
                }
            }, 1000); // 1 FPS analysis
        });
    } catch (error) {
        console.error("Webcam/FaceAPI Error:", error);
        emotionBadge.textContent = 'Camera Error: Check console';
    }
}

// --- Speech-to-Text (Web Speech API) ---
function initSpeechRecognition() {
    window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!window.SpeechRecognition) {
        alert("Your browser does not support the Web Speech API. Please use Chrome or Edge.");
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        voiceOrb.classList.add('listening');
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        interimTextEl.innerText = interimTranscript;

        // Low Latency Barge-In Trigger: As soon as user speaks (interim or final)
        if ((interimTranscript.trim().length > 0 || finalTranscript.trim().length > 0) && isPlaying) {
            handleBargeIn();
        }

        // When sentence is complete
        if (finalTranscript.trim() !== '') {
            appendUserText(finalTranscript);
            sendToBackend(finalTranscript);
        }
    };

    recognition.onerror = (event) => {
        console.error("Speech Recognition Error:", event.error);
        if (event.error === 'not-allowed') {
            alert("Microphone access denied. Cannot proceed.");
            stopAssistant();
        }
    };

    recognition.onend = () => {
        if (isAssistantActive) {
            try {
                recognition.start();
            } catch (e) { }
        } else {
            voiceOrb.classList.remove('listening');
        }
    };
}

// --- Audio Handling (Stage 3) ---
async function handleAudioChunk(arrayBuffer) {
    if (!audioContext) return;

    try {
        // Decode the MP3 array buffer into an AudioBuffer
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioQueue.push(audioBuffer);
        playNextInQueue();
    } catch (err) {
        console.error("Error decoding audio buffer:", err);
    }
}

function playNextInQueue() {
    if (isPlaying || audioQueue.length === 0 || !audioContext) return;

    isPlaying = true;
    const buffer = audioQueue.shift();

    activeSource = audioContext.createBufferSource();
    activeSource.buffer = buffer;
    activeSource.connect(audioContext.destination);

    activeSource.onended = () => {
        isPlaying = false;
        activeSource = null;
        playNextInQueue();
    };

    activeSource.start(0);
}

function handleBargeIn() {
    stopActiveAudioPlayback();

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ interrupt: true }));
    }
}

function stopActiveAudioPlayback() {
    // Clear pending audio
    audioQueue = [];

    // Stop currently playing audio instantly
    if (activeSource) {
        try {
            activeSource.onended = null; // Prevent it from triggering the next item in the queue
            activeSource.stop();
        } catch (e) {
            // ignore if already stopped
        }
        try {
            activeSource.disconnect();
        } catch (e) { }
        activeSource = null;
    }
    isPlaying = false;
}

function sendToBackend(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = {
            user_text: text,
            visual_context: currentEmotion
        };
        ws.send(JSON.stringify(payload));
    }
}

// --- App Control ---
async function startAssistant() {
    isAssistantActive = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    transcriptBox.innerHTML = '';

    initAudioContext();
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    initWebSocket();
    await initVision();
    initSpeechRecognition();

    if (recognition) {
        try {
            recognition.start();
        } catch (e) { }
    }
}

function stopAssistant() {
    isAssistantActive = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (recognition) recognition.stop();
    voiceOrb.classList.remove('listening');

    if (emotionInterval) clearInterval(emotionInterval);

    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }

    stopActiveAudioPlayback();

    if (ws) ws.close();
}

startBtn.addEventListener('click', startAssistant);
stopBtn.addEventListener('click', stopAssistant);
