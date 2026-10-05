/*
  Ekspor laporan ke CSV.

  Isi berkas dihitung dari fungsi yang sama dengan yang mengisi layar, sehingga angka di layar
  dan angka di berkas tidak pernah berbeda. Yang berbeda hanya batas barisnya.

  Tiga hal yang menentukan bentuk berkasnya:

  1. Berkas diawali BOM UTF-8. Tanpa BOM, Excel di Windows menampilkan huruf beraksen dan tanda
     baca Indonesia sebagai karakter rusak, dan berkas yang isinya benar akan terlihat salah.

  2. Seluruh sel dikutip dan tanda kutip di dalamnya digandakan. Alasan atau nama pelanggan bisa
     memuat koma dan tanda kutip, dan tanpa pengutipan berkasnya akan bergeser kolom.

  3. Nilai null ditulis sebagai sel kosong, bukan nol. Pada laporan, null berarti angkanya belum
     dapat dihitung, dan menuliskannya sebagai nol akan mengubah artinya menjadi hasil hitungan
     yang bernilai nol.

  Selain itu mesin yang membuka berkas ini juga harus tahu bahwa berkasnya CSV. Google Sheets dan
  Excel sama-sama menghormati baris pertama sebagai tajuk, jadi baris ringkasan ditulis sebagai
  komentar berawalan tanda pagar di bagian atas.
*/
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { parseSearchParams } from "@/lib/server/parse";
import { AppError } from "@/lib/server/errors";
import { buildReport, MAX_EXPORT_ROWS, REPORT_TYPES, type ReportType } from "@/lib/server/reports";
import { routeHandler } from "@/lib/server/route";
import { reportQuerySchema } from "@/lib/schemas/admin-report";

type Params = { params: Promise<{ type?: string }> };

/*
  Pemisah kolom yang dipakai Excel versi Indonesia bisa berupa titik koma, tetapi kontrak
  menetapkan koma. Koma dipertahankan, dan pengutipan sel yang benar membuat berkasnya tetap
  terbaca di Excel meski pengaturannya berbeda.
*/
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  /* Tanda kutip digandakan, lalu seluruh sel dikutip. */
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

export const GET = routeHandler("admin.reports.export", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "report.read");

  const { type: rawType } = await (context as Params).params;
  if (!rawType || !REPORT_TYPES.includes(rawType as ReportType)) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        `Jenis laporan "${rawType ?? ""}" tidak dikenal. Pilihan yang tersedia: ` +
        `${REPORT_TYPES.join(", ")}.`,
      details: { allowed: REPORT_TYPES },
    });
  }
  const type = rawType as ReportType;

  const query = parseSearchParams(new URL(request.url).searchParams, reportQuerySchema);
  const report = await buildReport(type, {
    from: query.from,
    to: query.to,
    granularity: query.granularity,
  });

  /*
    Batas baris diperiksa sebelum berkas disusun, bukan sesudah. Kalau diperiksa sesudah, satu
    permintaan yang meminta seluruh arsip sudah lebih dulu membebani database sebelum akhirnya
    ditolak.
  */
  if (report.rows.length > MAX_EXPORT_ROWS) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Laporan ini memuat ${report.rows.length.toLocaleString("id-ID")} baris, melebihi batas ` +
        `${MAX_EXPORT_ROWS.toLocaleString("id-ID")} baris per ekspor. Perpendek rentang ` +
        `tanggalnya, lalu unduh lagi.`,
      details: { rows: report.rows.length, max_rows: MAX_EXPORT_ROWS },
    });
  }

  const lines: string[] = [
    /* Ringkasan ditulis sebagai komentar supaya tajuk kolom tetap berada di baris yang dicari. */
    `# Laporan ${type}`,
    `# Periode ${report.period.from} sampai ${report.period.to}, waktu Jakarta`,
    `# Dasar perhitungan: ${report.definition}`,
    ...report.summary.map(
      (line) => `# ${line.label}: ${line.value === null ? "belum dapat dihitung" : line.value}`,
    ),
    ...report.notes.map((note) => `# Catatan: ${note}`),
    csvRow(report.columns.map((column) => column.label)),
    ...report.rows.map((row) => csvRow(report.columns.map((column) => row[column.key] as never))),
    /*
      Baris total diberi label pada kolom pertama. Tanpa label, baris itu terbaca sebagai baris
      data biasa, dan pembaca yang menjumlahkan kolomnya sendiri akan menghitung total dua kali.
    */
    csvRow(
      report.columns.map((column, index) =>
        index === 0 ? "TOTAL" : (report.totals[column.key] ?? null),
      ),
    ),
  ];

  /*
    BOM ditulis eksplisit. Tanpa ini, Excel di Windows akan menampilkan huruf beraksen sebagai
    karakter rusak, dan berkas yang isinya benar akan terlihat salah.
  */
  const body = `\uFEFF${lines.join("\r\n")}\r\n`;
  const filename = `nayaka-${type}-${report.period.from}-${report.period.to}.csv`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      /* Berkas laporan tidak boleh disinggahkan, karena isinya data pelanggan. */
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
});
