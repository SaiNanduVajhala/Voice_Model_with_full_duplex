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
let currentAge = 'unknown';
let currentGender = 'unknown';
let isDemographicsLocked = false;    // Stops age/gender from bouncing around
let lockedAge = 0;
let lockedGender = 'unknown';
let framesWithoutFace = 0;           // Timer to reset lock when user leaves camera
let emotionHistory = [];             // Array to hold the last 5 frames of emotions for smoothing
let isAssistantActive = false;
let emotionInterval = null;
let isInterrupted = false;

// --- Audio Playback State (Stage 3) ---
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let activeSource = null;
let gainNode = null;

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
                } else if (data.type === 'demographic_update') {
                    // Receive Gemini's highly accurate evaluation
                    currentAge = data.age;
                    currentGender = data.gender;
                    // Force the UI badge update immediately
                    emotionBadge.innerHTML = `Emotion: ${currentEmotion}<br/>Age: ${currentAge} | Gender: ${currentGender}`;
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
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
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

                const detections = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceExpressions();
                if (detections) {
                    framesWithoutFace = 0; // Reset lost-face timer
                    const resizedDetections = faceapi.resizeResults(detections, displaySize);
                    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

                    // --- 1. Emotion Processing (Always Updates, with Smoothing) ---
                    const rawExpressions = detections.expressions;

                    // Add current frame to history and keep only last 5 frames
                    emotionHistory.push(rawExpressions);
                    if (emotionHistory.length > 5) {
                        emotionHistory.shift();
                    }

                    // Calculate average for each emotion across the history
                    const smoothedExpressions = {};
                    const emotionLabels = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
                    for (const emotion of emotionLabels) {
                        // Default to 0 if the emotion isn't present in the frame
                        smoothedExpressions[emotion] = emotionHistory.reduce((sum, frame) => sum + (frame[emotion] || 0), 0) / emotionHistory.length;
                    }

                    // Find the top emotion using the smoothed averages
                    const topEmotion = Object.keys(smoothedExpressions).reduce((a, b) => smoothedExpressions[a] > smoothedExpressions[b] ? a : b);
                    currentEmotion = topEmotion;
                    const topConfidence = smoothedExpressions[topEmotion];

                    // --- 2. Demographic Locking (Image Capture for Gemini) ---
                    if (!isDemographicsLocked) {
                        isDemographicsLocked = true; // Instantly lock so we only send ONE frame to Gemini per face
                        currentAge = "Estimating...";
                        currentGender = "Estimating...";

                        // Extract a lightweight snapshot of the full video frame to send to Gemini Vision
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = 640; // Downscale for faster upload
                        tempCanvas.height = 480;
                        const tempCtx = tempCanvas.getContext('2d');
                        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
                        const base64Image = tempCanvas.toDataURL('image/jpeg', 0.8);

                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'analyze_demographics', image: base64Image }));
                        }
                    }

                    // --- 3. UI Updates ---
                    emotionBadge.innerHTML = `Emotion: ${topEmotion} (${Math.round(topConfidence * 100)}%)<br/>Age: ${currentAge} | Gender: ${currentGender}`;

                    // --- 4. Proactive AI Interruption (Controller) ---
                    if ((topEmotion === 'angry' || topEmotion === 'sad' || topEmotion === 'happy') && topConfidence > 0.85) {
                        if (window.lastInterruptedEmotion !== topEmotion && !isPlaying) {
                            window.lastInterruptedEmotion = topEmotion;
                            console.log(`Triggering AI Interruption due to high-confidence ${topEmotion}`);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ ai_interrupt: true, emotion: topEmotion }));
                            }
                        }
                    } else if (topEmotion === 'neutral') {
                        window.lastInterruptedEmotion = null; // Reset so they can be interrupted again
                    }
                } else {
                    currentEmotion = 'none';
                    emotionHistory = []; // Clear history if face is lost
                    emotionBadge.innerHTML = 'No face detected<br/>Scanning...';

                    // Allow 3 seconds (3 frames at 1000ms interval) of no-face before resetting the demographic locks
                    framesWithoutFace++;
                    if (framesWithoutFace > 3) {
                        isDemographicsLocked = false;
                        lockedAge = 0;
                        lockedGender = 'unknown';
                        currentAge = 'unknown';
                        currentGender = 'unknown';
                    }
                }
            }, 1000); // 1 FPS analysis
        });
    } catch (error) {
        console.error("Webcam/FaceAPI Error:", error);
        emotionBadge.textContent = 'Camera Error: Check console';
    }
}

// --- Speech-to-Text (Web Speech API) ---
async function initSpeechRecognition() {
    // Stage 1: Attempt to force the hardware to apply Acoustic Echo Cancellation before the Speech API grabs it
    try {
        await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
    } catch (e) {
        console.warn("Could not force hardware AEC:", e);
    }

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
                finalTranscript += event.results[i][0].transcript.toLowerCase();
            } else {
                interimTranscript += event.results[i][0].transcript.toLowerCase();
            }
        }

        interimTextEl.innerText = interimTranscript;

        // --- Software Acoustic Echo Cancellation (AEC) ---
        // We are in Full-Duplex mode, meaning the mic is ALWAYS on.
        let isEcho = false;

        if (isPlaying) {
            // We evaluate both the interim (fast, but hallucinates) and final (slow, but accurate) transcripts.
            const micTextRaw = (interimTranscript + finalTranscript).trim().toLowerCase();
            const micText = micTextRaw.replace(/[^\w\s\']|_/g, "").replace(/\s+/g, " ");

            const aiTextElements = transcriptBox.querySelectorAll('.ai-message');
            if (aiTextElements.length > 0) {
                let lastAiText = aiTextElements[aiTextElements.length - 1].innerText.toLowerCase();
                if (aiTextElements.length > 1) {
                    lastAiText += " " + aiTextElements[aiTextElements.length - 2].innerText.toLowerCase();
                }
                lastAiText = lastAiText.replace(/[^\w\s\']|_/g, "").replace(/\s+/g, " ");

                if (lastAiText.includes(micText) && micText.length > 3) {
                    isEcho = true; // Perfect substring match of speaker bleed
                } else if (micText.length > 0) {
                    const micWords = micText.split(' ').filter(w => w.length > 2);
                    const aiWords = lastAiText.split(' ');
                    if (micWords.length > 0) {
                        const intersection = micWords.filter(word => aiWords.includes(word));
                        // If 40% or more of the words match the AI script, it's an echo.
                        if (intersection.length / micWords.length >= 0.4) {
                            isEcho = true;
                        }
                    }
                }
            }

            // Genuine Barge-In Logic (While AI is speaking)
            if (!isEcho) {
                const wordCount = micText.trim().split(/\s+/).length;

                // 1. FAST PATH: Interim transcript grows significantly long without matching the AI script.
                // Re-enables fast full-duplex interruption without waiting for the sentence to finish.
                if (wordCount >= 3 && micText.length > 12) {
                    console.log("Genuine user interruption (Fast Path):", micText);
                    if (gainNode) gainNode.gain.value = 1.0;
                    handleBargeIn();
                }
                // 2. SLOW PATH: User said something short (like "Stop"), so we wait for the STT to finalize it to be sure it wasn't a static pop.
                else if (finalTranscript.trim().length > 0) {
                    console.log("Genuine user interruption (Finalized Short Command):", micText);
                    if (gainNode) gainNode.gain.value = 1.0;
                    handleBargeIn();
                }
            }
        } else {
            if (gainNode) gainNode.gain.value = 1.0;

            // Simple Barge-In Logic (When AI is silent)
            if (finalTranscript.trim().length > 0) {
                handleBargeIn();
            }
        }

        if (!isEcho && finalTranscript.trim() !== '') {
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

        // If the user interrupted while this chunk was decoding or downloading, drop it!
        if (isInterrupted) return;

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

    // Audio Ducking Node Setup
    if (!gainNode) {
        gainNode = audioContext.createGain();
        gainNode.connect(audioContext.destination);
    }
    gainNode.gain.value = 1.0; // Default full volume
    activeSource.connect(gainNode);

    activeSource.onended = () => {
        isPlaying = false;
        activeSource = null;
        playNextInQueue();
    };

    activeSource.start(0);
}

function handleBargeIn() {
    isInterrupted = true;
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
        isInterrupted = false; // Reset interruption flag for the new conversation turn
        const voiceSelector = document.getElementById('voice-persona');
        const payload = {
            user_text: text,
            visual_context: currentEmotion,
            age: currentAge,
            gender: currentGender,
            voice_preference: voiceSelector ? voiceSelector.value : "woman"
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
    await initSpeechRecognition();

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
