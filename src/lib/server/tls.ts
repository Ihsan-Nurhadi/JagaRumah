import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConnectionOptions } from "node:tls";

/*
  Pengaturan TLS untuk koneksi database.

  Kenapa berkas ini ada, bukan sekadar menambahkan `?sslmode=require` di DATABASE_URL:
  mengandalkan parameter URL berarti pengaturan keamanan bergantung pada setiap tempat yang
  menulis URL itu. Satu tempat yang lupa, dan koneksinya turun ke tanpa enkripsi tanpa ada yang
  sadar. Di sini pengaturannya dipasang otomatis untuk seluruh proses.

  Keadaan Supabase yang perlu diketahui: koneksi langsung ke PostgreSQL sudah diklasifikasikan
  "Legacy" oleh Supabase, dan jalur yang mereka sarankan sekarang adalah pooler. Pooler
  Supavisor menutup TLS di sisinya lalu meneruskan ke database tanpa TLS, sehingga
  `pg_stat_ssl` di sisi backend bernilai false meski sambungan dari aplikasi sudah terenkripsi
  penuh. Karena itu nilai itu tidak dipakai sebagai bukti enkripsi di sini.

  Sertifikat pooler diterbitkan oleh "Supabase Root 2021 CA". Akar itu tidak ada di penyimpanan
  CA bawaan sistem, jadi tanpa jangkar tambahan verifikasinya selalu gagal. Akar itu disimpan di
  db/certs dan dipakai sebagai jangkar.

  Yang perlu jujur dicatat: akar ini diperoleh langsung dari koneksi pertama dan tidak dapat
  dicocokkan ke halaman unduhan resmi Supabase, yang saat ini tidak menyediakan berkasnya.
  Artinya ini trust-on-first-use, bukan verifikasi terhadap sumber pihak ketiga. Yang tetap
  berlaku: sertifikatnya harus diterbitkan akar tersebut, namanya harus cocok, dan masa
  berlakunya harus belum lewat. Cabut akar ini dan ganti dari sumber resmi begitu tersedia.
*/
const CA_PATH = resolve(process.cwd(), "db/certs/supabase-root-2021-ca.pem");

let cachedCa: string | null = null;

function pinnedCa(): string | null {
  if (cachedCa !== null) return cachedCa;
  try {
    cachedCa = readFileSync(CA_PATH, "utf8");
  } catch {
    /*
      Berkas akar hilang bukan alasan mematikan verifikasi. Yang terjadi adalah koneksi ditolak
      dengan pesan yang menyebut berkas yang tidak ada, sehingga penyebabnya langsung terbaca.
      Diam-diam turun ke "tanpa verifikasi" justru yang harus dihindari.
    */
    console.error(
      `[tls] Akar CA tidak ditemukan di ${CA_PATH}. Koneksi database akan ditolak. ` +
        `Kembalikan berkas itu ke repo, atau arahkan DATABASE_URL ke server yang sertifikatnya ` +
        `sudah dipercaya sistem.`,
    );
    cachedCa = "";
  }
  return cachedCa === "" ? null : cachedCa;
}

/*
  Dipakai sebagai `ssl` pada pg.Pool dan pg.Client.

  Pilihan ini dinyatakan sebagai objek, bukan lewat `sslmode` pada URL, karena pg versi 8.23
  menerjemahkan `sslmode=require` menjadi `verify-full`, sedangkan perilaku libpq yang diharapkan
  adalah verifikasi tanpa nama host. Perbedaan itu membuat koneksi gagal dengan pesan
  SELF_SIGNED_CERT_IN_CHAIN yang menyesatkan.
*/
export function databaseSsl(connectionString: string): ConnectionOptions | false {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }

  const host = url.hostname;
  const sslMode = url.searchParams.get("sslmode");

  // Server lokal, misalnya untuk pengujian, memang tidak memakai TLS.
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  if (isLocal || sslMode === "disable") return false;

  const ca = pinnedCa();
  if (!ca) {
    /*
      Mengembalikan objek tanpa ca berarti verifikasi tetap menyala dan akan gagal, yang memang
      perilaku yang diinginkan dibanding koneksi tanpa enkripsi.
    */
    return { rejectUnauthorized: true };
  }

  return { ca, rejectUnauthorized: true };
}

/*
  Menyiapkan opsi koneksi untuk pg.

  Kenapa kata sandi dipindahkan keluar dari URL: pg menggabungkan opsi yang dikirim di kode
  dengan hasil parsing connection string memakai `Object.assign({}, config, parse(url))`, dan
  hasil parsing ditaruh paling akhir. Artinya parameter apa pun di dalam URL menimpa opsi yang
  ditulis di kode. Kalau `sslmode` ada di URL, pengaturan TLS di berkas ini bisa dibatalkan
  tanpa jejak. Karena itu parameter TLS dibuang dari URL, lalu koneksinya disusun sebagai
  objek terpisah dengan kata sandi yang tetap dibaca dari URL.

  Yang tidak dilakukan di sini: mematikan verifikasi. Kalau akar CA hilang, koneksi ditolak,
  bukan turun ke tanpa enkripsi.
*/
export function buildConnectionConfig(connectionString: string): {
  connectionString: string;
  ssl: ConnectionOptions | false;
} {
  const url = new URL(connectionString);
  const ssl = databaseSsl(connectionString);

  // Parameter TLS dibuang supaya tidak bisa menimpa keputusan di databaseSsl().
  for (const key of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) {
    url.searchParams.delete(key);
  }

  return { connectionString: url.toString(), ssl };
}

/*
  Memastikan sambungan yang sedang terbuka benar-benar terenkripsi.

  `pg_stat_ssl` tidak bisa dipakai sebagai bukti, karena pooler Supabase menutup TLS di sisinya
  dan kolom itu melaporkan keadaan sambungan pooler ke database, bukan sambungan aplikasi ke
  pooler. Yang diperiksa di sini adalah soket yang dipegang proses ini sendiri.

  Dipanggil skrip CLI sebelum pekerjaan yang menyentuh data. Kalau enkripsinya ternyata tidak
  aktif, lebih baik berhenti sekarang daripada mengirim kata sandi dan data pelanggan lewat
  jaringan terbuka.
*/
export function assertEncrypted(client: unknown, connectionString: string): void {
  const ssl = databaseSsl(connectionString);
  if (!ssl) return;

  const stream = (client as { connection?: { stream?: unknown } })?.connection?.stream as
    | { getPeerCertificate?: unknown }
    | undefined;

  if (typeof stream?.getPeerCertificate !== "function") {
    throw new Error(
      "Sambungan database TIDAK terenkripsi padahal seharusnya. Perintah dihentikan sebelum " +
        "ada data yang dikirim. Periksa DATABASE_URL dan berkas db/certs.",
    );
  }
}

/*
  Dipakai skrip CLI untuk menampilkan keadaan enkripsi tanpa membocorkan kata sandi.
*/
export function describeTls(connectionString: string): string {
  const ssl = databaseSsl(connectionString);
  if (!ssl) return "tanpa TLS (server lokal)";
  return ssl.ca ? "TLS aktif, akar CA dari repo" : "TLS aktif, akar CA TIDAK ADA";
}
