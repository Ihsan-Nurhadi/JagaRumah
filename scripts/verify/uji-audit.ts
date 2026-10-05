/* Uji modul audit: empat endpoint baca dan satu endpoint cabut sesi. */

/*
  Penanda bahwa berkas ini modul, bukan skrip global. Tanpa ini, setiap nama variabel di
  tingkat atas akan bertabrakan dengan berkas pemeriksaan lain saat diperiksa TypeScript.
*/
export {};

const B = "http://127.0.0.1:4401";
let cookies: Record<string, string> = {};
const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
function simpan(r: Response) {
  for (const b of r.headers.getSetCookie?.() ?? []) {
    const [p] = b.split(";");
    const i = p.indexOf("=");
    cookies[p.slice(0, i)] = p.slice(i + 1);
  }
}

let lulus = 0;
let gagal = 0;
function cek(nama: string, syarat: boolean, ket?: string) {
  if (syarat) {
    lulus++;
    console.log(`  ok   ${nama}`);
  } else {
    gagal++;
    console.log(`  GAGAL ${nama}${ket ? ` — ${ket}` : ""}`);
  }
}

async function get(path: string) {
  const res = await fetch(B + path, { headers: { Cookie: header() } });
  simpan(res);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function post(path: string) {
  const res = await fetch(B + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: header(), "X-CSRF-Token": cookies["admin_csrf_token"] ?? "" },
  });
  simpan(res);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Masuk sebagai admin uji.
await fetch(B + "/api/v1/admin/auth/csrf").then(simpan);
await fetch(B + "/api/v1/admin/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: header(), "X-CSRF-Token": cookies["admin_csrf_token"] },
  body: JSON.stringify({ email: "verifikasi-sementara@nayaka.test", password: "VerifikasiSementara1A" }),
}).then(simpan);

for (const p of [
  "/api/v1/admin/audit-logs",
  "/api/v1/admin/login-attempts",
  "/api/v1/admin/admin-sessions",
  "/api/v1/admin/session-events",
]) {
  const r = await get(p);
  cek(`GET ${p} 200`, r.status === 200, `status ${r.status}`);
}

// Endpoint lama harus benar-benar hilang, bukan hanya dialihkan.
for (const p of [
  "/api/v1/admin/audit/logs",
  "/api/v1/admin/audit/sessions",
  "/api/v1/admin/audit/login-attempts",
  "/api/v1/admin/audit/session-events",
]) {
  const r = await get(p);
  cek(`endpoint lama ${p} sudah hilang`, r.status === 404, `status ${r.status}`);
}

// Tab sesi memuat kolom yang dipakai tombol cabut.
const sesi = await get("/api/v1/admin/admin-sessions?limit=100");
const baris = sesi.json?.data?.sessions ?? [];
cek("daftar sesi terisi", baris.length > 0, `${baris.length} baris`);
cek("ada sesi aktif", baris.some((s: any) => s.status === "active" && !s.revoked_at), JSON.stringify(baris.map((s: any) => s.status)));
cek("setiap sesi punya id admin", baris.every((s: any) => s.admin?.id), "ada baris tanpa admin.id");

// Cabut sesi milik admin sendiri harus ditolak.
const me = await get("/api/v1/admin/me");
const idSendiri = me.json?.data?.admin?.id;
const milikSendiri = baris.find((s: any) => s.admin?.id === idSendiri && s.status === "active");
if (milikSendiri) {
  const tolak = await post(`/api/v1/admin/admin-sessions/${milikSendiri.id}/revoke`);
  cek("cabut sesi sendiri ditolak 400", tolak.status === 400, `status ${tolak.status} ${JSON.stringify(tolak.json?.error?.message ?? "")}`);
} else {
  cek("ada sesi sendiri untuk diuji", false, "tidak menemukan sesi sendiri yang aktif");
}

// Sesi yang tidak ada harus 404.
const tid = await post("/api/v1/admin/admin-sessions/00000000-0000-4000-8000-000000000000/revoke");
cek("sesi tidak dikenal ditolak 404", tid.status === 404, `status ${tid.status}`);

/*
  Alamat yang bukan UUID ditolak sebelum menyentuh database.

  Kodenya 404, bukan 400, dan itu memang disengaja di seluruh aplikasi: id yang tidak sah berarti
  sumber daya di alamat itu memang tidak ada. Yang diuji di sini adalah bahwa permintaannya
  ditolak, bukan kode spesifiknya.
*/
const bukanUuid = await post("/api/v1/admin/admin-sessions/bukan-uuid/revoke");
cek("alamat bukan uuid ditolak 404", bukanUuid.status === 404, `status ${bukanUuid.status}`);

// Tanpa CSRF ditolak.
const tanpaCsrf = await fetch(B + "/api/v1/admin/admin-sessions/00000000-0000-4000-8000-000000000000/revoke", {
  method: "POST",
  headers: { Cookie: header() },
});
cek("tanpa CSRF ditolak 403", tanpaCsrf.status === 403, `status ${tanpaCsrf.status}`);

// Filter tab sesi.
const filtStatus = await get("/api/v1/admin/admin-sessions?status=revoked");
cek("filter status 200", filtStatus.status === 200);
const filtAneh = await get("/api/v1/admin/admin-sessions?status=ngawur");
cek("status ngawur ditolak 400", filtAneh.status === 400, `status ${filtAneh.status}`);

// Filter pada audit-logs dan login-attempts.
cek("audit-logs dengan filter 200", (await get("/api/v1/admin/audit-logs?actor_type=admin")).status === 200);
cek("audit-logs actor_type ngawur ditolak 400", (await get("/api/v1/admin/audit-logs?actor_type=ngawur")).status === 400);
cek("login-attempts dengan filter 200", (await get("/api/v1/admin/login-attempts?outcome=success")).status === 200);
cek("login-attempts outcome ngawur ditolak 400", (await get("/api/v1/admin/login-attempts?outcome=ngawur")).status === 400);

// session-events: jenis yang tidak dikenal ditolak.
const evAneh = await get("/api/v1/admin/session-events?event_type=ngawur");
cek("session-events jenis ngawur ditolak 400", evAneh.status === 400, `status ${evAneh.status}`);
const evSah = await get("/api/v1/admin/session-events?event_type=login");
cek("session-events jenis sah 200", evSah.status === 200);
cek(
  "session-events hanya memuat jenis yang diminta",
  (evSah.json?.data?.events ?? []).every((e: any) => e.event_type === "login"),
  JSON.stringify((evSah.json?.data?.events ?? []).map((e: any) => e.event_type)),
);

// Ringkasan tiap tab.
cek("audit-logs punya ringkasan", Boolean((await get("/api/v1/admin/audit-logs")).json?.data?.summary));
cek("login-attempts punya ringkasan", Boolean((await get("/api/v1/admin/login-attempts")).json?.data?.summary));
cek("admin-sessions punya ringkasan", Boolean((await get("/api/v1/admin/admin-sessions")).json?.data?.summary));
cek("session-events punya ringkasan", Boolean((await get("/api/v1/admin/session-events")).json?.data?.summary));

// Tanpa masuk sama sekali harus 401.
const tamu = await fetch(B + "/api/v1/admin/audit-logs");
cek("tanpa sesi ditolak 401", tamu.status === 401, `status ${tamu.status}`);

console.log(`\n  hasil: ${lulus} lulus, ${gagal} gagal`);
if (gagal > 0) process.exit(1);
