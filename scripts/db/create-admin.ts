/*
  Membuat admin pertama.

  Register publik tidak ada di sistem ini, jadi akun admin pertama hanya bisa lahir dari sini.
  Kata sandi diminta lewat prompt dan tidak pernah lewat argumen baris perintah, karena argumen
  tercatat di riwayat shell dan terlihat di daftar proses.
*/
import { createInterface } from "node:readline/promises";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { databaseUrl, describeTarget } from "./env";
import { buildConnectionConfig, describeTls } from "../../src/lib/server/tls";
/*
  Syarat kata sandi diambil dari modul bersama, bukan disalin ke sini.

  Ini yang paling penting dari seluruh berkas ini: skrip pembuat admin pertama adalah satu-satunya
  jalan masuk ke konsol. Kalau syaratnya disalin dan melenceng dari yang dipakai server, akun
  pertama tidak akan pernah bisa dibuat, dan tidak ada akun lain yang bisa memperbaikinya.
*/
import { PASSWORD_HINT, passwordProblem } from "../../src/lib/password-rules";

const BCRYPT_ROUNDS = 12;

/*
  Seluruh proses bergantung pada terminal interaktif. Diperiksa di awal, bukan saat giliran
  mengetik kata sandi, karena skrip yang dipanggil dari pipa akan tampak berjalan lalu berhenti
  tanpa pesan apa pun, dan pemanggilnya menyimpulkan akun sudah dibuat padahal tidak.
*/
function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Perintah ini butuh terminal interaktif dan tidak bisa dijalankan lewat pipa atau skrip " +
        "otomatis. Jalankan langsung di terminal.",
    );
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/*
  Kata sandi dibaca tanpa ditampilkan. Umpan baliknya hanya berupa jumlah karakter, supaya
  orang di sebelah layar tidak bisa membaca panjangnya sekaligus.
*/
async function askPassword(question: string): Promise<string> {
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("Dibatalkan."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(`${question}${"*".repeat(value.length)}`);
    };

    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  requireInteractiveTerminal();

  const email = normalizeEmail(await ask("Email admin: "));
  if (!email.includes("@")) throw new Error("Email tidak valid.");

  const fullName = (await ask("Nama lengkap: ")).trim();
  if (!fullName) throw new Error("Nama lengkap wajib diisi.");

  const username = (
    await ask("Username (kosongkan untuk memakai bagian sebelum @ pada email): ")
  ).trim();
  const resolvedUsername = username || email.split("@")[0];

  /*
    Syaratnya dicetak sebelum mengetik, bukan sesudah. Tanpa ini, orang mengetik kata sandi,
    mengetik ulang, baru diberi tahu syaratnya, lalu mengulang dari awal. Pesan yang muncul
    belakangan juga mudah disalahartikan sebagai kegagalan sistem.
  */
  console.log(`Syarat   : ${PASSWORD_HINT}`);

  const password = await askPassword("Kata sandi: ");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const confirmation = await askPassword("Ulangi kata sandi: ");
  if (confirmation !== password) throw new Error("Kata sandi tidak sama.");

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const client = new Client({ ...buildConnectionConfig(databaseUrl()) });
  // Dicetak sebelum connect, supaya kegagalan sambungan tetap memperlihatkan target dan
  // keadaan enkripsinya, bukan hanya pesan galat dari driver.
  console.log(`Target   : ${describeTarget()}`);
  console.log(`Enkripsi : ${describeTls(databaseUrl())}`);
  await client.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM admin_users WHERE email = $1 OR username = $2",
      [email, resolvedUsername],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new Error(
        `Email ${email} atau username ${resolvedUsername} sudah dipakai. Pakai nilai lain, ` +
          `atau ubah akun itu lewat halaman /admin-users.`,
      );
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO admin_users (username, email, full_name, password_hash, status, is_super_admin)
       VALUES ($1, $2, $3, $4, 'active', true)
       RETURNING id`,
      [resolvedUsername, email, fullName, passwordHash],
    );
    const adminUserId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO admin_user_roles (admin_user_id, role_id)
       SELECT $1, id FROM admin_roles WHERE code = 'super_admin'
       ON CONFLICT DO NOTHING`,
      [adminUserId],
    );

    /*
      Dicatat sebagai tindakan sistem karena dilakukan dari CLI, bukan dari sesi admin. Tanpa
      baris ini, akun admin pertama akan muncul tanpa jejak siapa yang membuatnya.
    */
    await client.query(
      `INSERT INTO audit_logs (actor_type, admin_user_id, action, entity_type, entity_id, new_data)
       VALUES ('system', NULL, 'admin.create', 'admin_user', $1, $2)`,
      [adminUserId, JSON.stringify({ email, username: resolvedUsername, via: "cli" })],
    );

    await client.query("COMMIT");
    console.log(`Admin ${resolvedUsername} (${email}) dibuat dengan role super_admin.`);
    console.log("Masuk lewat /login.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`Gagal membuat admin: ${error.message}`);
  process.exitCode = 1;
});
