/*
  Konfigurasi pm2 untuk konsol admin Nayaka.

  Dijalankan sebagai `next dev`, yaitu server pengembangan dengan pemantauan berkas. Setiap
  perubahan kode langsung dikompilasi ulang dan dikirim ke peramban lewat hot reload, jadi
  tidak perlu build ulang maupun restart pm2 setiap kali ada perubahan.

  Catatan: mode ini bukan mode produksi. Sebelum dipakai menampung data sungguhan, ganti
  kembali ke `start` setelah menjalankan `npm run build`.

  Host diikat ke 127.0.0.1 dengan sengaja. Konsol ini memegang data pelanggan dan pembayaran,
  dan belum ada lapisan otentikasi perangkat maupun TLS di depannya. Mengikatnya ke semua
  antarmuka berarti siapa pun yang bisa menjangkau mesin ini dapat membuka halaman masuk.
  Kalau nanti perlu diakses dari luar, tempatkan proxy terbalik ber-TLS di depannya, bukan
  dengan membuka host di sini.
*/
module.exports = {
  apps: [
    {
      name: "nayaka",
      cwd: "/home/unity008/Projekan/Nayaka",
      /*
        PM2 menjalankan biner lewat interpreter node, bukan lewat shell — argumen tambahan
        (host/port) tetap lewat `args`. `interpreter: "none"` membuat PM2 mengeksekusi skrip
        apa adanya, dan biner `next` di sini adalah shell wrapper sehingga akan gagal diparse
        oleh node kalau dijalankan dengan interpreter default.
      */
      interpreter: "none",
      script: "node_modules/.bin/next",
      args: "dev -H 127.0.0.1 -p 3101",
      /*
        `cwd` harus mutlak dan ada di sini, bukan hanya di `env`. `pm2 save` mencatat `cwd` dari
        shell yang menjalankan perintah simpan, bukan dari aplikasi. Kalau tidak ditulis di sini,
        aplikasi akan tercatat dengan direktori kerja milik proses lain, dan setelah reboot ia
        hidup di direktori yang salah lalu langsung mati.
      */
      cwd: "/home/unity008/Projekan/Nayaka",
      /*
        Port dipilih 3101 karena 3000, 3080, 3099, dan 3100 sudah dipakai aplikasi lain di
        mesin ini. Port itu bukan milik proyek ini, jadi jangan diubah tanpa memeriksa dulu.
      */
      env: {
        /*
          Harus `development`, bukan `production`. Server pengembangan menolak berjalan saat
          NODE_ENV sudah bernilai production, dan pemeriksaan bawaan Next.js ikut mati kalau
          nilainya dipaksa.
        */
        NODE_ENV: "development",
      },
      /* Satu proses dipakai karena mesin ini sudah menjalankan banyak aplikasi lain. */
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      /*
        Mode pengembangan menyimpan modul yang sudah dikompilasi di dalam memori dan jauh lebih
        boros daripada hasil build. Batas 512M membuat pm2 mematikan proses di tengah pemakaian.
      */
      max_memory_restart: "1536M",
      /*
        Log dipisah dari .cache supaya tidak ikut terhapus saat cache dibersihkan.
        .cache bukan tempat yang aman untuk catatan yang perlu ditengok lagi.
      */
      out_file: "/home/unity008/Projekan/Nayaka/logs/pm2-out.log",
      error_file: "/home/unity008/Projekan/Nayaka/logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
