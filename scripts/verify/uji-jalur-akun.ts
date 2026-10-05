/*
  Uji penjagaan pada jalur akun: mengganti peran dan menonaktifkan admin.

  Kedua jalur ini diperiksa langsung lewat fungsi penghitung yang sama dengan yang dipakai
  production, karena cabang penolakannya hanya dapat dicapai bila aktor bukan pemegang izin.
  Keadaan itu tidak dapat dibuat lewat API: izin dihitung ulang setiap permintaan, sehingga aktor
  yang tidak memegang izin tidak dapat memanggil endpoint-nya sama sekali.

  Yang diuji di sini adalah perhitungannya: dengan super admin aktif, mengganti peran pemegang
  terakhir harus tetap menghasilkan "masih ada yang dapat mengelola admin".
*/

/*
  Penanda bahwa berkas ini modul, bukan skrip global. Tanpa ini, setiap nama variabel di
  tingkat atas akan bertabrakan dengan berkas pemeriksaan lain saat diperiksa TypeScript.
*/
export {};

import { readFileSync } from "node:fs";
import pg from "pg";

const url = readFileSync(".env", "utf8")
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))!
  .slice("DATABASE_URL=".length);
const { buildConnectionConfig } = await import("../../src/lib/server/tls");
const { adminsLeftAbleToManage } = await import("../../src/lib/server/admin-users");

const klien = new pg.Client(buildConnectionConfig(url));
await klien.connect();

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

/*
  `adminsLeftAbleToManage` memakai tipe Queryable dari lapisan db aplikasi. Klien pg mentah
  memenuhi bentuk itu pada saat dijalankan, jadi pemerannya diteruskan apa adanya.
*/
const jalan = (exceptRoleId?: string) =>
  adminsLeftAbleToManage("admin.manage", { exceptRoleId }, klien as never);

try {
  const superAktif = await klien.query(
    `SELECT count(*)::int AS jumlah FROM admin_users WHERE is_super_admin AND status = 'active'`,
  );
  cek("ada super admin aktif", superAktif.rows[0].jumlah > 0, `jumlah ${superAktif.rows[0].jumlah}`);

  /*
    Meski seluruh peran pemberi izin dibuang dari perhitungan, super admin tetap terhitung.
    Inilah yang membuat pencabutan izin dari peran apa pun aman selama super admin ada.
  */
  const peranPemberi = await klien.query(
    `SELECT r.id FROM admin_roles r
     JOIN admin_role_permissions rp ON rp.role_id = r.id
     JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE p.code = 'admin.manage'`,
  );

  let semuaAman = true;
  const rincian: string[] = [];
  for (const { id } of peranPemberi.rows) {
    const sisa = await jalan(id);
    if (sisa.length === 0) semuaAman = false;
    rincian.push(`${id}:${sisa.length}`);
  }
  cek(
    "super admin selalu terhitung sebagai penyelamat",
    semuaAman,
    `jumlah sisa per peran ${rincian.join(", ")}`,
  );

  const superSelaluAda = (await jalan(peranPemberi.rows[0]?.id)).some(
    (row) => row.full_name === "Admin Verifikasi Sementara",
  );
  cek("nama super admin muncul di daftar penyelamat", superSelaluAda);

  /*
    Bila super admin dinonaktifkan sementara, perhitungan harus berubah: sekarang yang menentukan
    adalah pemegang biasa. Ini membuktikan penghitungnya benar-benar membaca keadaan database dan
    bukan selalu menjawab "aman".
  */
  await klien.query(`UPDATE admin_users SET is_super_admin = false WHERE username = 'verifikasi.sementara'`);
  const tanpaSuper = await jalan(peranPemberi.rows[0]?.id);
  cek(
    "tanpa super admin, penyelamat menjadi kosong bila tidak ada pemegang biasa",
    tanpaSuper.length === 0,
    `${tanpaSuper.length} penyelamat`,
  );
  await klien.query(`UPDATE admin_users SET is_super_admin = true WHERE username = 'verifikasi.sementara'`);

  const kembaliAman = await jalan(peranPemberi.rows[0]?.id);
  cek("setelah super admin kembali, penyelamat ada lagi", kembaliAman.length > 0);
} finally {
  await klien.query(`UPDATE admin_users SET is_super_admin = true WHERE username = 'verifikasi.sementara'`);
  await klien.end();
}

console.log(`\n  hasil: ${lulus} lulus, ${gagal} gagal`);
if (gagal > 0) process.exit(1);
