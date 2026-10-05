/*
  Uji bahwa pencabutan sesi benar-benar menghentikan akses admin lain.

  Yang diuji bukan hanya bahwa endpoint menjawab 200, tetapi bahwa sesi yang dicabut memang tidak
  dapat dipakai lagi. Endpoint yang menjawab 200 tanpa menghentikan apa pun adalah kegagalan yang
  paling berbahaya di sini, karena tampak berhasil.
*/

/*
  Penanda bahwa berkas ini modul, bukan skrip global. Tanpa ini, setiap nama variabel di
  tingkat atas akan bertabrakan dengan berkas pemeriksaan lain saat diperiksa TypeScript.
*/
export {};

const B = "http://127.0.0.1:4401";

function buatSesi() {
  const cookies: Record<string, string> = {};
  const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const simpan = (r: Response) => {
    for (const b of r.headers.getSetCookie?.() ?? []) {
      const [p] = b.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
  };
  return { cookies, header, simpan };
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

// Sesi super admin.
const boss = buatSesi();
boss.simpan(await fetch(B + "/api/v1/admin/auth/csrf"));
boss.simpan(await fetch(B + "/api/v1/admin/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: boss.header(), "X-CSRF-Token": boss.cookies["admin_csrf_token"] },
  body: JSON.stringify({ email: "verifikasi-sementara@nayaka.test", password: "VerifikasiSementara1A" }),
}));

async function bossApi(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: boss.header(),
      "X-CSRF-Token": boss.cookies["admin_csrf_token"] ?? "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  boss.simpan(res);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Siapkan akun kedua dengan peran finance.
const roles = await bossApi("GET", "/api/v1/admin/roles");
const finance = roles.json.data.roles.find((r: any) => r.code === "finance");
const buat = await bossApi("POST", "/api/v1/admin/admin-users", {
  username: "uji.cabut",
  email: "uji-cabut@nayaka.test",
  full_name: "Uji Cabut Sesi",
  password: "SandiUjiCabut1A",
  role_ids: [finance.id],
});
cek("akun kedua dibuat", buat.status === 201, `status ${buat.status} ${JSON.stringify(buat.json?.error ?? "")}`);
const idAkun2 = buat.json?.data?.admin_user?.id;

// Sesi akun kedua masuk.
const korban = buatSesi();
korban.simpan(await fetch(B + "/api/v1/admin/auth/csrf"));
const masuk2 = await fetch(B + "/api/v1/admin/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: korban.header(), "X-CSRF-Token": korban.cookies["admin_csrf_token"] },
  body: JSON.stringify({ email: "uji-cabut@nayaka.test", password: "SandiUjiCabut1A" }),
});
korban.simpan(masuk2);
cek("akun kedua berhasil masuk", masuk2.status === 200, `status ${masuk2.status}`);

const sebelum = await fetch(B + "/api/v1/admin/me", { headers: { Cookie: korban.header() } });
cek("sesi akun kedua hidup", sebelum.status === 200, `status ${sebelum.status}`);

// Super admin mencabut sesi akun kedua.
const sesi = await bossApi("GET", `/api/v1/admin/admin-sessions?admin_user_id=${idAkun2}&limit=100`);
const sesiAktif = (sesi.json?.data?.sessions ?? []).filter((s: any) => s.status === "active" && !s.revoked_at);
cek("sesi akun kedua terlihat", sesiAktif.length > 0, `${sesiAktif.length} sesi aktif`);
cek(
  "sesi tercatat milik akun kedua",
  sesiAktif.every((s: any) => s.admin.id === idAkun2),
  JSON.stringify(sesiAktif.map((s: any) => s.admin.id)),
);

const cabut = await bossApi("POST", `/api/v1/admin/admin-sessions/${sesiAktif[0].id}/revoke`);
cek("pencabutan berhasil 200", cabut.status === 200, `status ${cabut.status} ${JSON.stringify(cabut.json?.error ?? "")}`);
cek("catatan pencabutan menyebut akibatnya", typeof cabut.json?.data?.note === "string");

// Inti uji: sesi korban harus benar-benar mati.
const sesudah = await fetch(B + "/api/v1/admin/me", { headers: { Cookie: korban.header() } });
cek("sesi akun kedua tidak dapat dipakai lagi", sesudah.status === 401, `status ${sesudah.status}`);

// Cabut ulang harus ditolak.
const cabut2 = await bossApi("POST", `/api/v1/admin/admin-sessions/${sesiAktif[0].id}/revoke`);
cek("pencabutan kedua ditolak 400", cabut2.status === 400, `status ${cabut2.status}`);

// Jejak audit dan peristiwa sesi tercatat.
const audit = await bossApi("GET", "/api/v1/admin/audit-logs?action=admin_session.revoke&limit=100");
cek(
  "jejak audit pencabutan tercatat",
  (audit.json?.data?.logs ?? []).length > 0,
  JSON.stringify((audit.json?.data?.logs ?? []).map((l: any) => l.action)),
);

const ev = await bossApi("GET", `/api/v1/admin/session-events?event_type=revoked&admin_user_id=${idAkun2}&limit=100`);
const peristiwa = ev.json?.data?.events ?? [];
cek("peristiwa sesi 'revoked' tercatat", peristiwa.length > 0, `${peristiwa.length} peristiwa`);
cek(
  "peristiwa menyebut siapa yang mencabut",
  peristiwa.some((e: any) => e.metadata?.revoked_by_admin_id),
  JSON.stringify(peristiwa.map((e: any) => e.metadata)),
);
cek(
  "peristiwa dicatat atas nama pemilik sesi",
  peristiwa.every((e: any) => e.admin.id === idAkun2),
  JSON.stringify(peristiwa.map((e: any) => e.admin.id)),
);

// Bersihkan: nonaktifkan akun uji dan hapus sesinya.
await bossApi("POST", `/api/v1/admin/admin-users/${idAkun2}/deactivate`, {
  reason: "Uji pencabutan sesi selesai, akun uji tidak dipakai lagi",
});

console.log(`\n  hasil: ${lulus} lulus, ${gagal} gagal`);
if (gagal > 0) process.exit(1);
