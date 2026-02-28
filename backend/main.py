import os
import json
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from groq import AsyncGroq
from dotenv import load_dotenv
import edge_tts

# Load environment variables from .env file
load_dotenv()

app = FastAPI()

# Allow CORS for local frontend testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Groq client
api_key = os.environ.get("GROQ_API_KEY")
if not api_key:
    print("WARNING: GROQ_API_KEY environment variable not set. LLM responses will fail.")

client = AsyncGroq(api_key=api_key) if api_key else None
MODEL = "llama-3.1-8b-instant" # Fast, fully supported 8b model for lowest possible latency

# System prompt base
BASE_SYSTEM_PROMPT = """You are a helpful, empathetic, and extremely concise AI voice assistant. 
Since your responses will be spoken aloud to the user, keep them conversational and brief.
Do not use markdown formatting (like **bold** or asterisks) because it sounds bad when read by Text-to-Speech.
"""

TTS_VOICE = "en-US-JennyNeural"

async def text_to_speech_stream(text: str, websocket: WebSocket, interrupt_event: asyncio.Event):
    """
    Given a chunk of text, use edge-tts to generate audio and stream it over the websocket.
    """
    if not any(c.isalnum() for c in text):
        return
        
    try:
        communicate = edge_tts.Communicate(text, TTS_VOICE)
        audio_data = bytearray()
        async for chunk in communicate.stream():
            # If the user interrupted, stop generating and sending audio immediately
            if interrupt_event.is_set():
                print("TTS Aborted due to barge-in.")
                return
                
            if chunk["type"] == "audio":
                # Accumulate the raw MP3 audio bytes
                audio_data.extend(chunk["data"])
                
        # Send the complete MP3 audio buffer over the WebSocket
        if audio_data and not interrupt_event.is_set():
            await websocket.send_bytes(bytes(audio_data))
    except Exception as e:
        print(f"TTS Error: {e}")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected via WebSocket.")
    
    messages = [{"role": "system", "content": BASE_SYSTEM_PROMPT}]
    
    # Event to signal when the user interrupts (starts speaking again)
    interrupt_event = asyncio.Event()
    tts_tasks = set()

    try:
        while True:
            data_str = await websocket.receive_text()
            data = json.loads(data_str)
            
            # Handle barge-in/interrupt from client
            if data.get("interrupt"):
                print("--- Client interrupted playback. ---")
                interrupt_event.set() # Signal all running TTS tasks to stop
                # We do not append the interrupted response completely to history
                # Or we can just let it be.
                continue
                
            user_text = data.get("user_text")
            visual_context = data.get("visual_context", "neutral")
            
            if not user_text:
                continue
                
            # A new utterance begins, clear any previous interrupt signal
            interrupt_event.clear()
                
            print(f"User Said: '{user_text}' | Emotion Detected: {visual_context}")

            emotion_instruction = f"The user currently looks {visual_context}."
            if visual_context == "happy":
                emotion_instruction += " Match their positive energy."
            elif visual_context in ["sad", "angry"]:
                emotion_instruction += " Be very empathetic, gentle, and understanding."
            
            current_messages = messages.copy()
            current_messages.append({"role": "system", "content": f"Visual Context update: {emotion_instruction}"})
            current_messages.append({"role": "user", "content": user_text})
            
            messages.append({"role": "user", "content": user_text})

            if not client:
                error_msg = "I'm sorry, my language model is not configured."
                await websocket.send_text(json.dumps({"type": "text_chunk", "text": error_msg}))
                continue

            print("Assistant: ", end="", flush=True)
            try:
                stream = await client.chat.completions.create(
                    model=MODEL,
                    messages=current_messages,
                    stream=True,
                    max_tokens=150,
                    temperature=0.7
                )
                
                full_response = ""
                sentence_buffer = ""
                
                async for chunk in stream:
                    if interrupt_event.is_set():
                        # Stop Groq generation if interrupted
                        break
                        
                    content = chunk.choices[0].delta.content
                    if content:
                        full_response += content
                        sentence_buffer += content
                        print(content, end="", flush=True)
                        
                        await websocket.send_text(json.dumps({"type": "text_chunk", "text": content}))
                        
                        # Simple chunking for TTS: generate audio per sentence or phrase
                        if any(punc in content for punc in ['.', '!', '?', '\n', ',']) or len(sentence_buffer) > 40:
                            # Flush buffer to TTS
                            text_to_speak = sentence_buffer
                            sentence_buffer = ""
                            
                            # Fire and forget TTS task
                            tts_task = asyncio.create_task(text_to_speech_stream(text_to_speak, websocket, interrupt_event))
                            tts_tasks.add(tts_task)
                            tts_task.add_done_callback(tts_tasks.discard)
                
                # Flush remaining text
                if sentence_buffer and not interrupt_event.is_set():
                    tts_task = asyncio.create_task(text_to_speech_stream(sentence_buffer, websocket, interrupt_event))
                    tts_tasks.add(tts_task)
                    tts_task.add_done_callback(tts_tasks.discard)
                
                print()
                if not interrupt_event.is_set():
                    messages.append({"role": "assistant", "content": full_response})
                
            except Exception as e:
                print(f"\nGroq API Error: {e}")
                await websocket.send_text(json.dumps({"type": "text_chunk", "text": "Sorry, I had trouble processing that request."}))

    except WebSocketDisconnect:
        print("Client disconnected.")
        interrupt_event.set()
    except Exception as e:
        print(f"WebSocket Error: {e}")
        interrupt_event.set()

# Run with: uvicorn main:app --reload
