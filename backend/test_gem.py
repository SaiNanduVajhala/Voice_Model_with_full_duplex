import asyncio, os, base64
from dotenv import load_dotenv
from google import genai

load_dotenv()

async def test():
    client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))
    # Use a tiny valid 1x1 JPEG to verify it parses images correctly
    # 1x1 pixel JPEG
    jpeg_data = base64.b64decode("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")
    part = genai.types.Part.from_bytes(data=jpeg_data, mime_type='image/jpeg')
    try:
        res = await client.aio.models.generate_content(
            model='gemini-2.5-flash',
            contents=['What is this?', part]
        )
        print(res.text)
    except Exception as e:
        print("ERROR:", e)

if __name__ == "__main__":
    asyncio.run(test())
