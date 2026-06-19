import sys
import asyncio
import edge_tts

async def main():
    text_file = sys.argv[1]
    voice     = sys.argv[2]
    output    = sys.argv[3]
    text = open(text_file, encoding='utf-8').read().strip()
    if not text:
        sys.exit(1)
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output)

asyncio.run(main())
