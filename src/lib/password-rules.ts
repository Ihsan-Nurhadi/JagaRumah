/*
  Aturan kata sandi admin, ditulis di satu tempat.

  Sebelumnya aturan ini disalin ke empat berkas: validasi formulir, validasi server, skrip
  pembuat admin pertama, dan teks bantuan di layar. Salinan seperti itu selalu melenceng
  perlahan, dan yang paling merugikan adalah ketika skrip pembuat admin pertama menolak kata
  sandi yang sebenarnya diterima konsol, karena kegagalannya terjadi sebelum akun apa pun ada
  untuk memperbaikinya.

  Berkas ini tidak boleh mengimpor apa pun dari lapisan server. Isinya dipakai komponen klien
  untuk memeriksa masukan lebih dulu, dan komponen klien tidak boleh menarik kode database ke
  dalam berkas yang dikirim ke peramban.
*/

/*
  Panjang minimum 8.

  Angka ini penyeimbang, bukan patokan keamanan. Delapan karakter dengan campuran huruf besar,
  huruf kecil, dan angka sudah di luar jangkauan penebakan kata sandi yang umum dipakai orang,
  terutama karena login admin dibatasi percobaan dan setiap percobaan dicatat. Menaikkannya
  terlalu tinggi membuat orang menulis kata sandinya di tempat lain, dan itu kerugian yang lebih
  nyata daripada keuntungan teoretisnya.
*/
export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_MAX_LENGTH = 200;

/*
  Syarat yang belum terpenuhi, atau null bila kata sandi sudah memenuhi semuanya.

  Yang dikembalikan adalah satu masalah saja, bukan daftar, karena inilah yang dibutuhkan
  pemakainya: langkah berikutnya yang harus dikerjakan. Daftar panjang sekaligus membuat orang
  berhenti membacanya.
*/
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) return "Kata sandi terlalu panjang.";
  if (!/[a-z]/.test(password)) return "Tambahkan minimal satu huruf kecil.";
  if (!/[A-Z]/.test(password)) return "Tambahkan minimal satu huruf besar.";
  if (!/[0-9]/.test(password)) return "Tambahkan minimal satu angka.";
  return null;
}

/*
  Keterangan syarat untuk ditulis di layar, diambil dari nilai di atas supaya tidak bisa
  berbeda dengan aturan yang sebenarnya diperiksa.
*/
export const PASSWORD_HINT =
  `Minimal ${PASSWORD_MIN_LENGTH} karakter, dengan huruf kecil, huruf besar, dan angka. ` +
  "Kata sandi ini tidak dapat dilihat lagi setelah tersimpan.";
