const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export async function readFirstJpeg(response: Response): Promise<Buffer | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);

  try {
    while (buffer.length < 5 * 1024 * 1024) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = Buffer.concat([buffer, Buffer.from(chunk.value)]);

      const start = buffer.indexOf(JPEG_START);
      if (start < 0) continue;
      const end = buffer.indexOf(JPEG_END, start + JPEG_START.length);
      if (end < 0) continue;
      return buffer.subarray(start, end + JPEG_END.length);
    }
  } finally {
    await reader.cancel();
  }

  return null;
}