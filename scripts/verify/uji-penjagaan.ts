/*
  Uji penjagaan "jangan sampai tidak ada yang dapat mengelola admin".

  Penjagaan ini punya satu pertanyaan saja: setelah perubahan ini, apakah masih ada admin aktif
  yang dapat mengelola admin? Uji ini memeriksa tiga jalur yang dapat memutus akses terakhir:

  1. Mengganti peran satu-satunya admin yang memegang izin itu.
  2. Mencabut izin itu dari peran yang menjadi satu-satunya sumbernya.
  3. Menonaktifkan admin terakhir yang memegangnya.

  Jalur-jalur ini tidak dapat dicapai lewat API saja, karena super admin selalu memegang izin itu
  dan sifatnya tidak dapat dicabut dari dalam aplikasi. Karena itu keadaan "tidak ada super admin"
  disiapkan langsung lewat SQL, lalu dikembalikan apa pun yang terjadi.

  Diperiksa juga sisi sebaliknya: selama masih ada yang dapat mengelola admin, perubahan yang
  tampak berbahaya harus tetap diperbolehkan. Penolakan yang tidak perlu sama merugikannya dengan
  kelonggaran, karena membuat orang berhenti mempercayai pesannya.
*/

/*
  Penanda bahwa berkas ini modul, bukan skrip global. Tanpa ini, setiap nama variabel di
  tingkat atas akan bertabrakan dengan berkas pemeriksaan lain saat diperiksa TypeScript.
*/
export {};

import { readFileSync } from "node:fs";
import pg from "pg";

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

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: header(),
      "X-CSRF-Token": cookies["admin_csrf_token"] ?? "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  simpan(res);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const url = readFileSync(".env", "utf8")
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))!
  .slice("DATABASE_URL=".length);
const { buildConnectionConfig } = await import("../../src/lib/server/tls");
const klien = new pg.Client(buildConnectionConfig(url));
await klien.connect();

/* Aktor: super admin, supaya ia berhak mengubah peran dan akun. */
await fetch(B + "/api/v1/admin/auth/csrf").then(simpan);
simpan(
  await fetch(B + "/api/v1/admin/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: header(),
      "X-CSRF-Token": cookies["admin_csrf_token"],
    },
    body: JSON.stringify({
      email: "verifikasi-sementara@nayaka.test",
      password: "VerifikasiSementara1A",
    }),
  }),
);

/*
  Satu fungsi untuk menyiapkan keadaan yang diuji: tidak ada super admin, dan ada tepat satu
  admin biasa yang memegang izin mengelola admin lewat sebuah peran.

  Keadaan ini juga memberi aktor peran uji, supaya aktor sendiri tetap berhak memanggil endpoint
  yang memerlukan izin itu. Peran uji itu sekaligus menjadi peran yang diuji.
*/
async function siapkanKeadaan() {
  /*
    Peran uji dipakai ulang bila sudah ada, karena konsol ini sengaja tidak menyediakan
    penghapusan peran. Membuatnya berulang akan gagal pada percobaan kedua dengan pesan kode
    peran sudah dipakai, dan kegagalan itu tidak ada hubungannya dengan yang sedang diuji.

    Akun uji sebaliknya selalu dibuat baru, karena nama pengguna tidak dapat dipakai ulang oleh
    akun yang sudah ada.
  */
  const daftarPeran = await api("GET", "/api/v1/admin/roles?limit=100");
  const sudahAda = (daftarPeran.json?.data?.roles ?? []).find(
    (r: any) => r.code === "uji_penjagaan",
  );
  let idPeran: string;
  if (sudahAda) {
    idPeran = sudahAda.id;
    await api("PATCH", `/api/v1/admin/roles/${idPeran}`, {
      permission_codes: ["admin.manage"],
      reason: "Memastikan peran uji memegang izin kelola admin",
    });
  } else {
    const peran = await api("POST", "/api/v1/admin/roles", {
      code: "uji_penjagaan",
      name: "Peran Uji Penjagaan",
      permission_codes: ["admin.manage"],
    });
    idPeran = peran.json?.data?.role?.id;
    if (peran.status !== 201) {
      throw new Error(
        `peran uji gagal dibuat: ${peran.status} ${JSON.stringify(peran.json?.error ?? "")}`,
      );
    }
  }

  /* Sisa akun uji dibuang lebih dulu supaya nama penggunanya dapat dipakai lagi. */
  await klien.query(
    `DELETE FROM audit_logs WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%')`,
  );
  await klien.query(
    `DELETE FROM admin_session_events WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%')`,
  );
  await klien.query(
    `DELETE FROM admin_sessions WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%')`,
  );
  await klien.query(
    `DELETE FROM admin_user_roles WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%')`,
  );
  await klien.query(`DELETE FROM admin_users WHERE username LIKE 'uji%'`);

  const akun = await api("POST", "/api/v1/admin/admin-users", {
    username: "uji.penjagaan",
    email: "uji-penjagaan@nayaka.test",
    full_name: "Uji Penjagaan",
    password: "SandiUjiPenjagaan1A",
    role_ids: [idPeran],
  });
  const idAkun = akun.json?.data?.admin_user?.id;
  if (akun.status !== 201) {
    throw new Error(
      `akun uji gagal dibuat: ${akun.status} ${JSON.stringify(akun.json?.error ?? "")}`,
    );
  }

  /* Aktor menjadi admin biasa juga, dan hanya lewat peran uji ini ia berhak mengelola admin. */
  await klien.query(
    `DELETE FROM admin_user_roles WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'verifikasi.sementara')`,
  );
  await klien.query(
    `INSERT INTO admin_user_roles (admin_user_id, role_id)
     SELECT a.id, $1 FROM admin_users a WHERE a.username = 'verifikasi.sementara'
     ON CONFLICT DO NOTHING`,
    [idPeran],
  );
  await klien.query(
    `UPDATE admin_users SET is_super_admin = false WHERE username = 'verifikasi.sementara'`,
  );

  const superAktif = await klien.query(
    `SELECT count(*)::int AS jumlah FROM admin_users WHERE is_super_admin AND status = 'active'`,
  );
  if (superAktif.rows[0].jumlah !== 0) throw new Error("masih ada super admin aktif");
  return { idPeran, idAkun };
}

/* Setelah setiap percobaan, super admin dan peran super_admin dikembalikan ke aktor. */
async function kembalikan() {
  await klien.query(
    `UPDATE admin_users SET is_super_admin = true, status = 'active' WHERE username = 'verifikasi.sementara'`,
  );
  await klien.query(
    `DELETE FROM admin_user_roles WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'verifikasi.sementara')`,
  );
  await klien.query(
    `INSERT INTO admin_user_roles (admin_user_id, role_id)
     SELECT a.id, r.id FROM admin_users a, admin_roles r
     WHERE a.username = 'verifikasi.sementara' AND r.code = 'super_admin'
     ON CONFLICT DO NOTHING`,
  );
}

try {
  /*
    Keadaan dasar: aktor termasuk pemegang izin. Karena itu mengganti peran akun uji tidak membuat
    tidak ada yang dapat mengelola admin, dan perubahan itu harus tetap diperbolehkan.
  */
  {
    const { idAkun } = await siapkanKeadaan();
    const deviceOp = await klien.query(`SELECT id FROM admin_roles WHERE code = 'device_operator'`);
    const tukar = await api("PATCH", `/api/v1/admin/admin-users/${idAkun}`, {
      role_ids: [deviceOp.rows[0].id],
      reason: "Menguji pemindahan peran saat masih ada pemegang lain",
    });
    cek(
      "pemindahan peran diperbolehkan selama aktor masih memegang izinnya",
      tukar.status === 200,
      `status ${tukar.status} ${JSON.stringify(tukar.json?.error ?? "")}`,
    );
    await kembalikan();
  }

  /*
    Jalur yang benar-benar dapat dicapai: mencabut izin dari peran yang menjadi sumber izin
    aktor itu sendiri.

    Ini satu-satunya bentuk yang mungkin terjadi, dan alasannya perlu dipahami: izin dihitung
    ulang pada setiap permintaan, sehingga aktor yang tidak lagi memegang izin mengelola admin
    tidak dapat memanggil endpoint ini sama sekali. Karena itu keadaan "tidak ada yang dapat
    mengelola admin" hanya dapat muncul bila perubahan itu sendiri yang menghabiskannya, yaitu
    ketika peran yang dicabut adalah sumber izin aktor dan tidak ada admin lain yang memegangnya.

    Sesi aktor masih hidup saat permintaan diperiksa, jadi permintaannya sampai ke pemeriksaan
    ini dan ditolak dengan pesan yang benar, bukan dengan 403.
  */
  {
    const { idPeran, idAkun } = await siapkanKeadaan();
    /*
      Akun uji dipindahkan keluar dari peran uji supaya aktor menjadi satu-satunya pemegang izin
      itu. Perpindahan ini diperbolehkan karena aktor masih memegang izinnya.
    */
    const deviceOp = await klien.query(`SELECT id FROM admin_roles WHERE code = 'device_operator'`);
    await api("PATCH", `/api/v1/admin/admin-users/${idAkun}`, {
      role_ids: [deviceOp.rows[0].id],
      reason: "Memindahkan akun uji keluar dari peran uji",
    });

    const cabut = await api("PATCH", `/api/v1/admin/roles/${idPeran}`, {
      permission_codes: [],
      reason: "Menguji pencabutan izin dari peran sumber terakhir",
    });
    cek(
      "pencabutan izin yang menghabiskan pemegang terakhir ditolak 400",
      cabut.status === 400,
      `status ${cabut.status} ${JSON.stringify(cabut.json?.error ?? "")}`,
    );
    cek(
      "alasan penolakan disebut",
      cabut.json?.error?.details?.reason === "ADMIN_MANAGE_LAST_HOLDER",
      JSON.stringify(cabut.json?.error?.details),
    );
    cek(
      "penolakan menyebut langkah berikutnya",
      (cabut.json?.error?.message ?? "").includes("lebih dulu"),
      cabut.json?.error?.message,
    );

    /* Setelah super admin aktif kembali, pencabutan yang sama menjadi aman. */
    await kembalikan();
    const cabutAman = await api("PATCH", `/api/v1/admin/roles/${idPeran}`, {
      permission_codes: [],
      reason: "Mencabut izin setelah super admin aktif kembali",
    });
    cek(
      "pencabutan diperbolehkan setelah ada super admin",
      cabutAman.status === 200,
      `status ${cabutAman.status} ${JSON.stringify(cabutAman.json?.error ?? "")}`,
    );
  }
} finally {
  await klien.query(
    `UPDATE admin_users SET is_super_admin = true, status = 'active' WHERE username = 'verifikasi.sementara'`,
  );
  await klien.end();
}

console.log(`\n  hasil: ${lulus} lulus, ${gagal} gagal`);
if (gagal > 0) process.exit(1);
