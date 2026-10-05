/* Uji penuh modul admin, peran, dan izin lewat HTTP nyata. */

/*
  Penanda bahwa berkas ini modul, bukan skrip global. Tanpa ini, setiap nama variabel di
  tingkat atas akan bertabrakan dengan berkas pemeriksaan lain saat diperiksa TypeScript.
*/
export {};

const B = "http://127.0.0.1:4401";

/*
  Sesi dikelola sendiri oleh skrip ini, bukan lewat berkas jar curl.

  Alasannya: skrip ini mengubah peran dan menonaktifkan akun, dan sebagian tindakan itu mencabut
  sesi. Memakai jar bersama berarti uji ini bisa memutus sesi yang sedang dipakai uji lain.
  Cookie disimpan di memori dan diperbarui setiap tanggapan, sehingga rotasi refresh token
  tertangani sendiri.
*/
let cookies: Record<string, string> = {};

function cookieHeader(): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function simpanCookie(res: Response) {
  const mentah = res.headers.getSetCookie?.() ?? [];
  for (const baris of mentah) {
    const [pasangan] = baris.split(";");
    const idx = pasangan.indexOf("=");
    cookies[pasangan.slice(0, idx)] = pasangan.slice(idx + 1);
  }
}

/*
  Refresh token berumur 8 jam, tetapi access token hanya 15 menit. Uji ini panjang, jadi token
  diperbarui sendiri ketika server menjawab TOKEN_EXPIRED. Tanpa ini, uji akan gagal di
  tengah jalan dan kegagalannya menyesatkan.
*/
async function segarkanToken(): Promise<boolean> {
  try {
    const res = await fetch(B + "/api/v1/admin/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader() },
    });
    simpanCookie(res);
    return res.ok;
  } catch {
    return false;
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  csrf?: string,
): Promise<{ status: number; json: any }> {
  const kirim = () =>
    fetch(B + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await kirim();
  simpanCookie(res);
  let text = await res.text();

  if (text.includes("TOKEN_EXPIRED")) {
    if (await segarkanToken()) {
      res = await kirim();
      simpanCookie(res);
      text = await res.text();
    }
  }

  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function csrfDariCookie(): string {
  return cookies["admin_csrf_token"] ?? "";
}

let lulus = 0;
let gagal = 0;
function cek(nama: string, syarat: boolean, keterangan?: string) {
  if (syarat) {
    lulus++;
    console.log(`  ok   ${nama}`);
  } else {
    gagal++;
    console.log(`  GAGAL ${nama}${keterangan ? ` — ${keterangan}` : ""}`);
  }
}

async function main() {
  // Login dulu untuk mendapat cookie yang segar.
  /* Kode CSRF diambil dari cookie yang baru saja disimpan oleh permintaan di atas. */
  await api("GET", "/api/v1/admin/auth/csrf");
  const csrfAwal = csrfDariCookie();
  const masuk = await fetch(B + "/api/v1/admin/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(),
      "X-CSRF-Token": csrfAwal,
    },
    body: JSON.stringify({
      email: "verifikasi-sementara@nayaka.test",
      password: "VerifikasiSementara1A",
    }),
  });
  simpanCookie(masuk);
  cek("berhasil masuk", masuk.status === 200, `status ${masuk.status}`);

  const csrf = csrfDariCookie();
  cek("CSRF terbaca dari cookie", csrf.length > 10);
  const cekMasuk = await api("GET", "/api/v1/admin/me");
  cek("sesi berlaku", cekMasuk.status === 200, `status ${cekMasuk.status}`);

  /*
    Sisa akun dan peran dari jalan sebelumnya dibersihkan lebih dulu.

    Pembersihan tidak dapat dilakukan lewat API: konsol ini sengaja tidak menyediakan penghapusan
    admin maupun peran, karena keduanya punya jejak yang harus tetap utuh. Membersihkan lewat
    API hanya akan menonaktifkan akun, dan akun nonaktif tetap memakai nama penggunanya sehingga
    pembuatan ulang tetap gagal. Karena itu sisa data uji dibersihkan lewat berkas SQL terpisah
    sebelum uji ini dijalankan, dan di sini keberadaannya diperiksa agar kegagalannya jelas.
  */
  const daftarAwal = (await api("GET", "/api/v1/admin/admin-users?limit=100")).json;
  const sisaAkun = (daftarAwal.data?.admin_users ?? []).filter((u: any) =>
    u.username.startsWith("uji."),
  );
  cek(
    "tidak ada sisa akun uji",
    sisaAkun.length === 0,
    `jalankan npm run db:sql -- scripts/verify/bersih-data-uji.sql dulu: ${sisaAkun.map((u: any) => u.username).join(", ")}`,
  );
  const peranAwal = (await api("GET", "/api/v1/admin/roles?limit=100")).json;
  const sisaPeran = (peranAwal.data?.roles ?? []).filter((r: any) => r.code === "uji_peran");
  cek(
    "tidak ada sisa peran uji",
    sisaPeran.length === 0,
    "jalankan npm run db:sql -- scripts/verify/bersih-data-uji.sql dulu",
  );

  // Ambil id peran finance dan device_operator.
  const roles = (await api("GET", "/api/v1/admin/roles")).json;
  const finance = roles.data.roles.find((r: any) => r.code === "finance");
  const deviceOp = roles.data.roles.find((r: any) => r.code === "device_operator");
  cek("peran finance ada", Boolean(finance));

  // 1. Membuat akun tanpa peran ditolak.
  const tanpaPeran = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.admin1",
    email: "uji-admin1@nayaka.test",
    full_name: "Uji Admin Satu",
    password: "SandiUjiAdmin1A",
    role_ids: [],
  }, csrf);
  cek("akun tanpa peran ditolak 400", tanpaPeran.status === 400, `status ${tanpaPeran.status}`);

  // 2. Kata sandi lemah ditolak.
  const sandiLemah = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.admin1",
    email: "uji-admin1@nayaka.test",
    full_name: "Uji Admin Satu",
    password: "sandi-lemah",
    role_ids: [finance.id],
  }, csrf);
  cek("kata sandi lemah ditolak 400", sandiLemah.status === 400, `status ${sandiLemah.status}`);
  /*
    Yang diperiksa adalah pesannya menunjuk kolom kata sandi, bukan isi pesannya. Isi pesan
    bergantung pada syarat mana yang gagal lebih dulu, dan "sandi-lemah" gagal pada syarat huruf
    besar, bukan pada panjangnya. Mengunci isi pesannya di sini akan membuat uji ini gagal setiap
    kali urutan pemeriksaan dirapikan, padahal yang diuji adalah penolakannya.
  */
  cek(
    "pesan menunjuk kolom kata sandi",
    typeof sandiLemah.json.error?.details?.fields?.password === "string" &&
      sandiLemah.json.error.details.fields.password.length > 0,
    JSON.stringify(sandiLemah.json.error?.details),
  );

  /*
    Batas panjang diperiksa langsung pada syaratnya, karena inilah nilai yang paling mudah
    berubah. Delapan karakter harus diterima, dan tujuh harus ditolak.
  */
  const sandiDelapan = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.delapan",
    email: "uji-delapan@nayaka.test",
    full_name: "Uji Delapan",
    password: "SandiUj1",
    role_ids: [finance.id],
  }, csrf);
  cek(
    "kata sandi 8 karakter diterima",
    sandiDelapan.status === 201,
    `status ${sandiDelapan.status} ${JSON.stringify(sandiDelapan.json?.error ?? "")}`,
  );

  const sandiTujuh = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.tujuh",
    email: "uji-tujuh@nayaka.test",
    full_name: "Uji Tujuh",
    password: "SandiU1",
    role_ids: [finance.id],
  }, csrf);
  cek("kata sandi 7 karakter ditolak", sandiTujuh.status === 400, `status ${sandiTujuh.status}`);

  // 3. Peran tidak dikenal ditolak.
  const peranAneh = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.admin1",
    email: "uji-admin1@nayaka.test",
    full_name: "Uji Admin Satu",
    password: "SandiUjiAdmin1A",
    role_ids: ["00000000-0000-4000-8000-000000000000"],
  }, csrf);
  cek("peran tidak dikenal ditolak 400", peranAneh.status === 400, `status ${peranAneh.status}`);

  // 4. Akun sah dibuat.
  const buat = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.admin1",
    email: "uji-admin1@nayaka.test",
    full_name: "Uji Admin Satu",
    password: "SandiUjiAdmin1A",
    role_ids: [finance.id],
  }, csrf);
  cek("akun sah dibuat 201", buat.status === 201, `status ${buat.status} ${JSON.stringify(buat.json)}`);
  const idBaru = buat.json?.data?.admin_user?.id;
  cek("id akun baru ada", Boolean(idBaru));
  cek("kata sandi tidak dikembalikan", !JSON.stringify(buat.json).includes("SandiUjiAdmin1A"));

  // 5. Nama pengguna sama ditolak.
  const duplikat = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.admin1",
    email: "lain@nayaka.test",
    full_name: "Uji Lain",
    password: "SandiUjiAdmin1A",
    role_ids: [finance.id],
  }, csrf);
  cek("username sama ditolak 409", duplikat.status === 409, `status ${duplikat.status}`);
  cek("kode galat benar", duplikat.json.error?.code === "ADMIN_USERNAME_TAKEN", duplikat.json.error?.code);

  // 6. Email sama ditolak.
  const duplikatEmail = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.lain",
    email: "uji-admin1@nayaka.test",
    full_name: "Uji Lain",
    password: "SandiUjiAdmin1A",
    role_ids: [finance.id],
  }, csrf);
  cek("email sama ditolak 409", duplikatEmail.status === 409, `status ${duplikatEmail.status}`);
  cek("kode galat email benar", duplikatEmail.json.error?.code === "ADMIN_EMAIL_TAKEN", duplikatEmail.json.error?.code);

  // 7. Detail akun baru.
  const detail = await api("GET", `/api/v1/admin/admin-users/${idBaru}`);
  cek("detail 200", detail.status === 200, `status ${detail.status}`);
  cek("peran terbaca", detail.json.data?.roles?.[0]?.code === "finance", JSON.stringify(detail.json.data?.roles));
  cek(
    "izin efektif dari finance",
    (detail.json.data?.effective_permissions ?? []).some((p: any) => p.code === "invoice.read"),
    JSON.stringify(detail.json.data?.effective_permissions?.map((p: any) => p.code)),
  );
  cek("is_self false", detail.json.data?.is_self === false);

  // 8. PATCH ganti peran → sesi dicabut.
  const patch = await api("PATCH", `/api/v1/admin/admin-users/${idBaru}`, {
    role_ids: [deviceOp.id],
    reason: "Pindah tugas ke bagian perangkat",
  }, csrf);
  cek("ubah peran 200", patch.status === 200, `status ${patch.status} ${JSON.stringify(patch.json)}`);
  cek("sesi dicabut dicatat", patch.json.data?.effect?.sessions_revoked === true, JSON.stringify(patch.json.data?.effect));
  const detail2 = await api("GET", `/api/v1/admin/admin-users/${idBaru}`);
  cek("peran sudah berubah", detail2.json.data?.roles?.[0]?.code === "device_operator", JSON.stringify(detail2.json.data?.roles));

  // 9. PATCH tanpa perubahan apa pun ditolak.
  const kosong = await api("PATCH", `/api/v1/admin/admin-users/${idBaru}`, { reason: "Tidak ada perubahan isi" }, csrf);
  cek("patch kosong ditolak 400", kosong.status === 400, `status ${kosong.status}`);

  // 10. Menonaktifkan diri sendiri ditolak.
  const me = (await api("GET", "/api/v1/admin/me")).json;
  const idSendiri = me.data?.admin?.id;
  const self = await api("POST", `/api/v1/admin/admin-users/${idSendiri}/deactivate`, { reason: "Mencoba menonaktifkan diri sendiri" }, csrf);
  cek("nonaktifkan diri sendiri ditolak 400", self.status === 400, `status ${self.status}`);
  cek("pesan menjelaskan", (self.json.error?.message ?? "").includes("admin lain"), self.json.error?.message);

  // 11. Mengubah peran diri sendiri ditolak.
  const selfPatch = await api("PATCH", `/api/v1/admin/admin-users/${idSendiri}`, {
    role_ids: [finance.id],
    reason: "Mencoba mengubah peran diri sendiri",
  }, csrf);
  cek("ubah peran diri sendiri ditolak 400", selfPatch.status === 400, `status ${selfPatch.status}`);

  // 12. Nonaktifkan akun uji.
  const nonaktif = await api("POST", `/api/v1/admin/admin-users/${idBaru}/deactivate`, { reason: "Uji selesai, akun uji tidak dipakai lagi" }, csrf);
  cek("nonaktifkan 200", nonaktif.status === 200, `status ${nonaktif.status} ${JSON.stringify(nonaktif.json)}`);
  cek("sesi dicabut 0 karena belum pernah masuk", nonaktif.json.data?.effect?.sessions_revoked === 0, JSON.stringify(nonaktif.json.data?.effect));

  // 13. Nonaktifkan dua kali ditolak.
  const nonaktif2 = await api("POST", `/api/v1/admin/admin-users/${idBaru}/deactivate`, { reason: "Mencoba menonaktifkan kedua kalinya" }, csrf);
  cek("nonaktif dua kali ditolak 400", nonaktif2.status === 400, `status ${nonaktif2.status}`);

  // 14. Buat peran baru.
  const peranBaru = await api("POST", "/api/v1/admin/roles", {
    code: "uji_peran",
    name: "Peran Uji",
    description: "Peran untuk pengujian",
    permission_codes: [],
  }, csrf);
  cek("peran baru dibuat 201", peranBaru.status === 201, `status ${peranBaru.status} ${JSON.stringify(peranBaru.json)}`);
  const idPeran = peranBaru.json?.data?.role?.id;
  cek("izin awal kosong", peranBaru.json.data?.role?.permission_count === 0);

  // 15. Kode peran sama ditolak.
  const peranDuplikat = await api("POST", "/api/v1/admin/roles", {
    code: "uji_peran",
    name: "Peran Uji Dua",
    permission_codes: [],
  }, csrf);
  cek("kode peran sama ditolak 400", peranDuplikat.status === 400, `status ${peranDuplikat.status}`);

  // 16. Kode izin tidak dikenal ditolak.
  const izinAneh = await api("PATCH", `/api/v1/admin/roles/${idPeran}`, {
    permission_codes: ["izin.palsu"],
    reason: "Mencoba memberi izin yang tidak ada",
  }, csrf);
  cek("izin tidak dikenal ditolak 400", izinAneh.status === 400, `status ${izinAneh.status}`);

  /*
    17. Izin mengelola admin tetap ada setelah perubahan.

    Yang diperiksa di sini adalah sisi yang benar-benar dapat terjadi: selama masih ada super
    admin aktif, mencabut izin mengelola admin dari sebuah peran TIDAK boleh ditolak, karena
    tidak ada yang terkunci. Menolaknya justru akan menghalangi pekerjaan yang sepenuhnya aman.

    Jalur penolakan diuji terpisah di uji-penjagaan.ts, karena jalur itu hanya dapat dicapai bila
    tidak ada super admin aktif sama sekali.
  */
  const peranUjiIzin = await api("POST", "/api/v1/admin/roles", {
    code: "uji_izin",
    name: "Peran Uji Izin",
    permission_codes: ["admin.manage"],
  }, csrf);
  const idPeranIzin = peranUjiIzin.json?.data?.role?.id;
  cek("peran uji berizin admin.manage dibuat", peranUjiIzin.status === 201, `status ${peranUjiIzin.status}`);

  const pemegang = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.pemegang",
    email: "uji-pemegang@nayaka.test",
    full_name: "Uji Pemegang Izin",
    password: "SandiUjiPemegang1A",
    role_ids: [idPeranIzin],
  }, csrf);
  cek("akun pemegang dibuat", pemegang.status === 201, `status ${pemegang.status}`);

  /*
    Selama super admin masih ada, pencabutan ini aman dan harus berhasil. Uji ini menahan
    godaan untuk membuat penjagaan yang lebih ketat dari yang perlu.
  */
  const cabutSelamaAdaSuperAdmin = await api("PATCH", `/api/v1/admin/roles/${idPeranIzin}`, {
    permission_codes: [],
    reason: "Mencabut izin selama masih ada super admin aktif",
  }, csrf);
  cek(
    "pencabutan diperbolehkan selama masih ada super admin",
    cabutSelamaAdaSuperAdmin.status === 200,
    `status ${cabutSelamaAdaSuperAdmin.status} ${JSON.stringify(cabutSelamaAdaSuperAdmin.json?.error ?? "")}`,
  );

  const superRole = roles.data.roles.find((r: any) => r.code === "super_admin");
  const superUtuh = (await api("GET", `/api/v1/admin/roles/${superRole.id}`)).json;
  cek(
    "izin super_admin tidak tersentuh",
    superUtuh.data?.role?.permission_count === 20,
    `jumlah ${superUtuh.data?.role?.permission_count}`,
  );

  // 18. PATCH izin peran uji.
  const beriIzin = await api("PATCH", `/api/v1/admin/roles/${idPeran}`, {
    permission_codes: ["customer.read", "device.read"],
    reason: "Menguji pemberian izin",
  }, csrf);
  cek("beri izin 200", beriIzin.status === 200, `status ${beriIzin.status}`);
  cek("jumlah izin 2", beriIzin.json.data?.role?.permission_count === 2, String(beriIzin.json.data?.role?.permission_count));

  // 19. Detail peran memuat pemegang.
  const detailPeran = await api("GET", `/api/v1/admin/roles/${idPeran}`);
  cek("detail peran 200", detailPeran.status === 200);
  cek("pemegang kosong", detailPeran.json.data?.holders?.length === 0);

  /*
    20. Ringkasan daftar admin.

    Yang diperiksa bukan angka mutlaknya, melainkan bahwa ringkasannya konsisten dengan isi
    daftarnya. Angka mutlak bergantung pada berapa akun yang sudah ada, sehingga pemeriksaan
    seperti itu akan gagal karena alasan yang tidak ada hubungannya dengan yang sedang diuji.
  */
  const daftar = (await api("GET", "/api/v1/admin/admin-users?limit=100")).json;
  const akun = daftar.data?.admin_users ?? [];
  cek(
    "total ringkasan sama dengan isi daftar",
    daftar.data?.summary?.total === akun.length,
    `ringkasan ${daftar.data?.summary?.total}, daftar ${akun.length}`,
  );
  cek(
    "sudah tidak ada admin biasa tanpa peran",
    daftar.data?.summary?.without_role === 0,
    JSON.stringify(daftar.data?.summary),
  );
  cek(
    "akun uji yang dinonaktifkan terhitung tidak aktif",
    akun.some((u: any) => u.username === "uji.admin1" && u.status === "inactive"),
    JSON.stringify(akun.map((u: any) => `${u.username}:${u.status}`)),
  );

  // 21. Tanpa CSRF ditolak.
  const tanpaCsrf = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.tanpa.csrf",
    email: "tanpa-csrf@nayaka.test",
    full_name: "Tanpa CSRF",
    password: "SandiUjiAdmin1A",
    role_ids: [finance.id],
  });
  cek("tanpa CSRF ditolak 403", tanpaCsrf.status === 403, `status ${tanpaCsrf.status}`);

  console.log(`\n  hasil: ${lulus} lulus, ${gagal} gagal`);
  if (gagal > 0) process.exit(1);
}

main();
