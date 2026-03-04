import os
import json
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# API Clients
from groq import AsyncGroq
from openai import AsyncOpenAI
from google import genai
from google.genai import types as genai_types
import edge_tts
from elevenlabs.client import AsyncElevenLabs

load_dotenv(override=True)
print("Loaded Keys:", {k: bool(v) for k, v in os.environ.items() if "KEY" in k})

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === CONFIGURATION ===
# Set your active providers here!
# LLM Options: "groq", "openai", "gemini", "openrouter"
ACTIVE_LLM_PROVIDER = "groq"
ACTIVE_LLM_MODEL = "llama-3.1-8b-instant" 

# TTS Options: "edge-tts", "elevenlabs", "openai_tts"
ACTIVE_TTS_PROVIDER = "elevenlabs"
TTS_VOICE_EDGE = "en-US-JennyNeural"
TTS_VOICE_OPENAI = "alloy"


# === CLIENT INITIALIZATION ===
api_keys = {
    "groq": os.environ.get("GROQ_API_KEY"),
    "openai": os.environ.get("OPENAI_API_KEY"),
    "gemini": os.environ.get("GEMINI_API_KEY"),
    "openrouter": os.environ.get("OPENROUTER_API_KEY"),
    "elevenlabs": os.environ.get("ELEVENLABS_API_KEY"),
}

clients = {}
if api_keys["groq"]: clients["groq"] = AsyncGroq(api_key=api_keys["groq"])
if api_keys["openai"]: clients["openai"] = AsyncOpenAI(api_key=api_keys["openai"])
if api_keys["openrouter"]: clients["openrouter"] = AsyncOpenAI(api_key=api_keys["openrouter"], base_url="https://openrouter.ai/api/v1")
if api_keys["gemini"]: clients["gemini"] = genai.Client(api_key=api_keys["gemini"])
if api_keys["elevenlabs"]: clients["elevenlabs"] = AsyncElevenLabs(api_key=api_keys["elevenlabs"])

BASE_SYSTEM_PROMPT = """You are a helpful, empathetic, and extremely concise AI voice assistant. 
Since your responses will be spoken aloud to the user, keep them conversational and brief.
Do not use markdown formatting (like **bold** or asterisks) because it sounds bad when read by Text-to-Speech.
"""

# === TTS ROUTING ===
async def get_audio_bytes(text: str, interrupt_event: asyncio.Event, voice_preference: str = "woman"):
    if not any(c.isalnum() for c in text):
        return b""
        
    global ACTIVE_TTS_PROVIDER
    provider = ACTIVE_TTS_PROVIDER
    
    # Map personas to specific ElevenLabs Voice IDs
    eleven_voices = {
        "woman": "21m00Tcm4TlvDq8ikWAM",  # Rachel
        "man": "tx3xeO11kLw500oQ5d6B",    # Josh
        "robotic": "ErXwobaYiN019PkySvjV",# Antony
        "scary": "JBFqnCBsd6RMkjVDRZzb"   # George
    }
    target_voice_id = eleven_voices.get(voice_preference, "21m00Tcm4TlvDq8ikWAM")
    
    try:
        if provider == "elevenlabs":
            if "elevenlabs" not in clients:
                print("ElevenLabs API key missing. Falling back...")
                ACTIVE_TTS_PROVIDER = "edge-tts"
                provider = "edge-tts"
            else:
                try:
                    # Streaming from ElevenLabs with Extreme Latency Optimization
                    audio_generator = await clients["elevenlabs"].text_to_speech.convert(
                        text=text,
                        voice_id=target_voice_id,
                        model_id="eleven_turbo_v2_5",
                        output_format="mp3_44100_128",
                        optimize_streaming_latency=3 # Maximum latency optimization (sacrifices slight audio quality for extreme speed)
                    )
                    # Collect into bytearray to send a complete MP3 file
                    audio_data = b""
                    async for chunk in audio_generator:
                        if interrupt_event.is_set(): return b""
                        if chunk:
                            audio_data += chunk
                    
                    return audio_data
                except Exception as e:
                    print(f"ElevenLabs Error: {e} -> Falling back to edge-tts")
                    ACTIVE_TTS_PROVIDER = "edge-tts"
                    provider = "edge-tts"

        if provider == "edge-tts":
            edge_voices = {
                "woman": "en-US-AriaNeural",
                "man": "en-US-GuyNeural",
                "robotic": "en-US-SteffanNeural",
                "scary": "en-GB-RyanNeural"
            }
            voice = edge_voices.get(voice_preference, TTS_VOICE_EDGE)
            communicate = edge_tts.Communicate(text, voice, rate="+20%")
            # Collect into bytearray to send a complete MP3 file
            audio_data = b""
            async for chunk in communicate.stream():
                if interrupt_event.is_set(): return b""
                if chunk["type"] == "audio":
                    audio_data += chunk["data"]
            
            return audio_data
                
        elif provider == "openai_tts":
            if "openai" not in clients:
                print("OpenAI API key missing.")
                return
            
            # OpenAI TTS doesn't support streaming well via SDK chunks yet, but we'll send it as one block
            response = await clients["openai"].audio.speech.create(
                model="tts-1",
                voice=TTS_VOICE_OPENAI,
                input=text,
                response_format="mp3"
            )
            return response.content
            
    except Exception as e:
        print(f"TTS Error ({provider}): {e}")
        return b""

# === LLM ROUTING ===
async def generate_llm_response(messages: list, websocket: WebSocket, interrupt_event: asyncio.Event, voice_preference: str = "woman"):
    provider = ACTIVE_LLM_PROVIDER
    model = ACTIVE_LLM_MODEL
    
    if provider not in clients:
        error_msg = f"Error: Provider '{provider}' not configured properly. Check your .env file."
        await websocket.send_text(json.dumps({"type": "text_chunk", "text": error_msg}))
        print(error_msg)
        return ""
        
    full_response = ""
    sentence_buffer = ""
    
    tts_queue = asyncio.Queue()
    
    async def tts_worker():
        while True:
            task_data = await tts_queue.get()
            if task_data is None:
                tts_queue.task_done()
                break
            
            if not interrupt_event.is_set():
                try:
                    text, voice_pref = task_data
                    # Generate and send sequentially to guarantee exact order
                    audio_data = await get_audio_bytes(text, interrupt_event, voice_pref)
                    if audio_data and not interrupt_event.is_set():
                        await websocket.send_bytes(audio_data)
                except Exception as e:
                    print(f"Error awaiting TTS task: {e}")
            
            tts_queue.task_done()
            
    worker_task = asyncio.create_task(tts_worker())
    
    try:
        # OpenAI, OpenRouter, and Groq all use the OpenAI Chat Completions standard
        if provider in ["groq", "openai", "openrouter"]:
            stream = await clients[provider].chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
                max_tokens=150,
                temperature=0.7
            )
            async for chunk in stream:
                if interrupt_event.is_set():
                    print("\n[LLM Stream Interrupted]")
                    break
                content = chunk.choices[0].delta.content if chunk.choices else None
                if content:
                    full_response += content
                    sentence_buffer += content
                    print(content, end="", flush=True)
                    await websocket.send_text(json.dumps({"type": "text_chunk", "text": content}))
                    
                    # Trigger TTS heavily on punctuation.
                    # This ensures ElevenLabs can add proper conversational inflections.
                    if any(punc in content for punc in ['.', '!', '?', '\n']) or (len(sentence_buffer) > 40 and ',' in content):
                        text_to_speak = sentence_buffer
                        sentence_buffer = ""
                        await tts_queue.put((text_to_speak, voice_preference))
                        
        # Google Gemini uses a completely different structure
        elif provider == "gemini":
            # Gemini models ignore 'system' roles in the message array and prefer instructions passed in config
            gemini_messages = ""
            for msg in messages:
                if msg["role"] != "system":
                    gemini_messages += f"{msg['role'].upper()}: {msg['content']}\n"
            
            # Use the asyncio extension built into google-genai
            response_stream = await clients["gemini"].aio.models.generate_content_stream(
                model=model,
                contents=gemini_messages,
                config=genai_types.GenerateContentConfig(
                    system_instruction=BASE_SYSTEM_PROMPT,
                    temperature=0.7,
                    max_output_tokens=150
                )
            )
            async for chunk in response_stream:
                if interrupt_event.is_set():
                    print("\n[LLM Stream Interrupted]")
                    break
                content = chunk.text
                if content:
                    full_response += content
                    sentence_buffer += content
                    print(content, end="", flush=True)
                    await websocket.send_text(json.dumps({"type": "text_chunk", "text": content}))
                    # Trigger TTS heavily on punctuation.
                    if any(punc in content for punc in ['.', '!', '?', '\n']) or (len(sentence_buffer) > 40 and ',' in content):
                        text_to_speak = sentence_buffer
                        sentence_buffer = ""
                        await tts_queue.put((text_to_speak, voice_preference))

        # Flush remaining buffer to TTS
        if sentence_buffer and not interrupt_event.is_set():
            await tts_queue.put((sentence_buffer, voice_preference))
            
        # Stop worker
        await tts_queue.put(None)
        await worker_task
            
        print()
        return full_response

    except Exception as e:
        print(f"\nLLM Error ({provider}): {e}")
        await websocket.send_text(json.dumps({"type": "text_chunk", "text": "Sorry, I had trouble processing that request."}))
        return full_response


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected via WebSocket.")
    
    messages = [{"role": "system", "content": BASE_SYSTEM_PROMPT}]
    interrupt_event = asyncio.Event()

    # --- Auto-Greeting Generation ---
    greeting_prompt = messages.copy()
    greeting_prompt.append({"role": "user", "content": "Hello! I just connected. Greet me warmly and briefly to start the conversation."})
    print(f"Assistant ({ACTIVE_LLM_PROVIDER}): ", end="", flush=True)
    full_response = await generate_llm_response(greeting_prompt, websocket, interrupt_event)
    if full_response and not interrupt_event.is_set():
        messages.append({"role": "assistant", "content": full_response})

    try:
        while True:
            data_str = await websocket.receive_text()
            data = json.loads(data_str)
            
            if data.get("type") == "analyze_demographics":
                print("--- Analyzing Demographics via Gemini Vision ---")
                try:
                    b64_img = data.get("image", "").split(",")[-1]
                    import base64
                    image_bytes = base64.b64decode(b64_img)
                    
                    if "gemini" in clients:
                        response = await clients["gemini"].aio.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=[
                                "Analyze this face. Return ONLY a raw JSON object containing exactly two keys: 'age' (a number) and 'gender' (a string: 'male', 'female', or 'unknown'). Do not return markdown, just the JSON.",
                                genai.types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
                            ]
                        )
                        result = response.text.replace("```json", "").replace("```", "").strip()
                        demo_data = json.loads(result)
                        await websocket.send_text(json.dumps({
                            "type": "demographic_update",
                            "age": demo_data.get("age", "unknown"),
                            "gender": demo_data.get("gender", "unknown")
                        }))
                        print(f"Demographics Locked: {demo_data}")
                    else:
                        print("Gemini API not configured. Sending default demographics.")
                        await websocket.send_text(json.dumps({
                            "type": "demographic_update",
                            "age": "unknown",
                            "gender": "unknown"
                        }))
                except Exception as e:
                    print(f"Gemini Vision Error: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "demographic_update",
                        "age": "unknown",
                        "gender": "unknown"
                    }))
                continue
            
            if data.get("interrupt"):
                print("--- Client interrupted playback. ---")
                interrupt_event.set()
                continue
                
            if data.get("ai_interrupt"):
                emotion = data.get("emotion")
                print(f"--- AI PROACTIVELY INTERRUPTING USER due to {emotion} ---")
                interrupt_event.clear()
                
                # --- Dynamic & Randomized Interruption Responses ---
                import random
                if emotion == "angry":
                    responses = [
                        "Please, take a deep breath. I can see you are getting upset.",
                        "Hold on a second, I can see this is frustrating you.",
                        "Let's pause. I can see that made you angry.",
                        "I hear your frustration. Let's take a step back for a moment."
                    ]
                    interrupt_msg = random.choice(responses)
                elif emotion == "sad":
                    responses = [
                        "I can see you are hurting. I am right here for you.",
                        "Take your time. I know this is difficult.",
                        "I can see you look sad. Do you want to talk about it?",
                        "I'm here to listen. You look like you need a friend right now."
                    ]
                    interrupt_msg = random.choice(responses)
                elif emotion == "happy":
                    responses = [
                        "You look so happy! I love seeing that smile.",
                        "That brought a smile to your face!",
                        "It's great to see you so joyful!",
                        "Your happiness is contagious! What's making you smile?"
                    ]
                    interrupt_msg = random.choice(responses)
                else:
                    interrupt_msg = "Just a moment, let's talk about this."
                await websocket.send_text(json.dumps({"type": "text_chunk", "text": f"\n\n**[AI Interrupted You ({emotion.upper()})]**\n{interrupt_msg}\n\n"}))
                
                # Play the interruption audio immediately
                interrupt_audio = await get_audio_bytes(interrupt_msg, interrupt_event, voice_preference="woman")
                if interrupt_audio and not interrupt_event.is_set():
                    await websocket.send_bytes(interrupt_audio)
                continue
                
            user_text = data.get("user_text")
            visual_context = data.get("visual_context", "neutral")
            user_age = data.get("age", "unknown")
            user_gender = data.get("gender", "unknown")
            voice_preference = data.get("voice_preference", "woman")
            
            if not user_text:
                continue
                
            interrupt_event.clear()
            print(f"User Said: '{user_text}' | Emotion: {visual_context} | Age: {user_age} | Gender: {user_gender} | Voice: {voice_preference}")

            # --- Dynamic Persona Injector ---
            emotion_instruction = f"The user is a {user_age}-year-old {user_gender} who currently looks {visual_context}."
            
            # Persona Style Adjustments
            if voice_preference == "robotic":
                emotion_instruction += " Speak in a highly clinical, monotone, computing, and calculating manner. Do not use contractions."
            elif voice_preference == "scary":
                emotion_instruction += " Speak ominously, deeply, darkly, and slightly menacingly."
            elif voice_preference == "man":
                emotion_instruction += " Speak like a confident, friendly human male."
            else:
                emotion_instruction += " Speak like a friendly, warm human female."
            
            # Age-based tone adjustments
            if isinstance(user_age, int):
                if user_age < 15:
                    emotion_instruction += " Speak to them sweetly, gently, and playfully like you are talking to a younger sibling or child. Do not use complex words."
                elif user_age >= 18:
                    emotion_instruction += " Speak to them as a mature adult. Maintain a respectful, sophisticated, and engaging tone."
            
            # Emotion-based tone adjustments
            if visual_context == "happy":
                emotion_instruction += " Match their positive energy!"
            elif visual_context in ["sad", "angry"]:
                emotion_instruction += " Be very empathetic, gentle, and understanding to de-escalate their mood."
            
            current_messages = messages.copy()
            current_messages.append({"role": "system", "content": f"Visual & Demographic Context update: {emotion_instruction}"})
            current_messages.append({"role": "user", "content": user_text})
            
            messages.append({"role": "user", "content": user_text})
            
            print(f"Assistant ({ACTIVE_LLM_PROVIDER}): ", end="", flush=True)
            
            full_response = await generate_llm_response(current_messages, websocket, interrupt_event, voice_preference)
            
            if full_response and not interrupt_event.is_set():
                messages.append({"role": "assistant", "content": full_response})

    except WebSocketDisconnect:
        print("Client disconnected.")
        interrupt_event.set()
    except Exception as e:
        print(f"WebSocket Error: {e}")
        interrupt_event.set()
