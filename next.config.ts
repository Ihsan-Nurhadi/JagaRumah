import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    Vercel hanya mengirim berkas yang jejaknya terbaca pelacak berkas Next.js. Akar CA dibaca
    lewat process.cwd() sehingga jejaknya tidak terdeteksi otomatis; tanpa baris ini db/certs
    tidak ikut terkirim dan seluruh koneksi database ditolak di sana.
  */
  output: "standalone",
  outputFileTracingIncludes: { "/**": ["db/certs/**"] },
};

export default nextConfig;
