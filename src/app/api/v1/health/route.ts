/*
  Endpoint pemeriksaan sederhana yang memakai envelope yang sama dengan
  kontrak API, supaya jalur data dari klien ke server bisa diuji sejak awal.
*/
export async function GET() {
  return Response.json({
    data: {
      status: "ok",
      checked_at: new Date().toISOString(),
    },
    meta: {
      request_id: crypto.randomUUID(),
    },
  });
}
