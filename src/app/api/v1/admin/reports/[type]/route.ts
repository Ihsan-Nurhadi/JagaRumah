/*
  Satu laporan.

  Bentuk response semua jenis laporan dibuat seragam: `columns` menentukan urutan dan label
  kolom, sehingga halaman laporan tidak perlu mengetahui bentuk tiap jenis. Menambah jenis
  laporan baru berarti menambah satu penyusun di sisi server, tanpa mengubah halamannya.

  `definition` wajib diisi setiap jenis dan berisi kalimat tentang bagaimana angkanya dihitung.
  Halaman menampilkan kalimat itu di bawah judul, karena angka pendapatan tanpa keterangan dasar
  perhitungan mudah disalahartikan sebagai uang yang masuk ke rekening.
*/
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { parseSearchParams } from "@/lib/server/parse";
import { buildReport, reportNeedsGranularity, REPORT_TYPES, type ReportType } from "@/lib/server/reports";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { reportQuerySchema } from "@/lib/schemas/admin-report";

type Params = { params: Promise<{ type?: string }> };

export const GET = routeHandler("admin.reports.show", async (request, requestId, context) => {
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

  /*
    Hanya laporan pendapatan dan refund yang punya arti per periode. Laporan piutang, perangkat,
    dan anomali berisi daftar objek, sehingga granularitasnya diabaikan, bukan diteruskan
    diam-diam ke query yang tidak memakainya.
  */
  const report = await buildReport(type, {
    from: query.from,
    to: query.to,
    granularity: query.granularity,
  });

  return ok(
    {
      ...report,
      granularity: reportNeedsGranularity(type) ? query.granularity : null,
      granularity_applies: reportNeedsGranularity(type),
    },
    requestId,
  );
});
