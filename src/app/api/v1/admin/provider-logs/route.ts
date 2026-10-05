/*
  Log provider pembayaran.

  Satu halaman untuk dua arah komunikasi dengan penyedia pembayaran, dan keduanya perlu terlihat
  bersamaan untuk bisa disimpulkan:

  - Arah masuk, dari `payment_webhook_events`: notifikasi yang dikirim penyedia ke kita.
  - Arah keluar, dari `payment_provider_calls`: panggilan yang kita kirim ke penyedia.

  Tanpa keduanya di satu layar, pertanyaan "pembayaran ini kenapa tidak aktif" hanya bisa
  dijawab dengan menebak. Dengan keduanya, jawabannya terlihat: notifikasinya tidak pernah
  datang, atau panggilan kita yang gagal, atau keduanya datang tetapi berisi hal yang berbeda.

  Karena notifikasi penyedia tidak bertanda tangan, kolom yang paling penting di sini adalah
  `outcome`, bukan isi payloadnya:

  - `verified` berarti notifikasi cocok dengan percobaan pembayaran setelah diperiksa ulang.
  - `pending` berarti notifikasi sudah masuk tetapi belum diproses sama sekali.
  - `rejected` berarti notifikasi tidak lolos pemeriksaan nominal, status, atau nomor pesanan.
  - `unknown_order` berarti nomor pesanannya tidak ada di database kita.

  `pending` dibedakan dari `rejected` dengan sengaja. Notifikasi yang belum diproses belum
  diputuskan apa pun: menyebutnya ditolak berarti menyimpulkan penolakan yang belum terjadi.
  Keadaan itu juga yang paling mungkin berarti job pemroses webhook tertinggal, dan itu masalah
  yang berbeda dari notifikasi palsu.

  `rejected` dan `unknown_order` adalah indikasi upaya pemalsuan. Keduanya direpresentasikan apa
  adanya, bukan diratakan menjadi satu status "bermasalah", supaya bisa dibedakan saat
  ditindaklanjuti.
*/
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { providerCalls, providerHealth, webhookEvents } from "@/lib/server/payments";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const DIRECTIONS = ["inbound", "outbound"] as const;
const INBOUND_OUTCOMES = ["verified", "pending", "rejected", "unknown_order"] as const;
const OUTBOUND_OUTCOMES = ["success", "failed"] as const;
const OUTCOMES = [...INBOUND_OUTCOMES, ...OUTBOUND_OUTCOMES] as const;

export const GET = routeHandler("admin.provider_logs.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "payment.read");

  const url = new URL(request.url);

  const direction = url.searchParams.get("direction");
  if (direction && !DIRECTIONS.includes(direction as (typeof DIRECTIONS)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Arah "${direction}" tidak dikenal. Pilihan yang tersedia: ${DIRECTIONS.join(", ")}.`,
      details: { direction, allowed: DIRECTIONS },
    });
  }

  const outcome = url.searchParams.get("outcome");
  if (outcome && !OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Hasil "${outcome}" tidak dikenal. Pilihan yang tersedia: ${OUTCOMES.join(", ")}.`,
      details: { outcome, allowed: OUTCOMES },
    });
  }

  /*
    Arah dan hasil harus sejalan. Meminta arah masuk dengan hasil "failed" tidak akan pernah
    mengembalikan baris apa pun, dan mengembalikan daftar kosong tanpa keterangan akan terbaca
    sebagai "tidak ada masalah" padahal sebenarnya permintaannya yang tidak masuk akal.
  */
  if (
    direction === "inbound" &&
    outcome &&
    !INBOUND_OUTCOMES.includes(outcome as (typeof INBOUND_OUTCOMES)[number])
  ) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Arah masuk hanya punya hasil ${INBOUND_OUTCOMES.join(", ")}. Hasil "${outcome}" hanya ` +
        `berlaku untuk arah keluar.`,
      details: { direction, outcome, allowed: INBOUND_OUTCOMES },
    });
  }

  if (
    direction === "outbound" &&
    outcome &&
    !OUTBOUND_OUTCOMES.includes(outcome as (typeof OUTBOUND_OUTCOMES)[number])
  ) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Arah keluar hanya punya hasil ${OUTBOUND_OUTCOMES.join(", ")}. Hasil "${outcome}" hanya ` +
        `berlaku untuk arah masuk.`,
      details: { direction, outcome, allowed: OUTBOUND_OUTCOMES },
    });
  }

  const orderId = url.searchParams.get("order_id")?.trim() || undefined;
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const limit = 50;

  const wantInbound = direction !== "outbound";
  const wantOutbound = direction !== "inbound";

  /*
    Hasil disaring di sisi server untuk arah masuk karena bentuk barisnya berbeda antara kedua
    tabel: arah masuk tidak menyimpan kolom `outcome`, melainkan menyimpulkan hasilnya dari
    ada tidaknya galat pemrosesan dan apakah nomor pesanannya dikenal.
  */
  const [webhooks, calls, health] = await Promise.all([
    wantInbound
      ? webhookEvents({
          providerOrderId: orderId,
          limit,
          processed: undefined,
          from,
          to,
          outcome: outcome as (typeof INBOUND_OUTCOMES)[number] | undefined,
        })
      : Promise.resolve([]),
    wantOutbound
      ? providerCalls({
          orderId,
          outcome: outcome as (typeof OUTBOUND_OUTCOMES)[number] | undefined,
          limit,
          from,
          to,
        })
      : Promise.resolve([]),
    providerHealth(),
  ]);

  /*
    Kedua arah digabung lalu diurutkan menurut waktu kejadian, bukan ditampilkan sebagai dua
    daftar terpisah. Urutan waktu inilah yang menunjukkan hubungan sebab akibat: notifikasi yang
    datang sebelum atau sesudah panggilan kita menentukan arah penelusurannya.
  */
  const rows = [
    ...webhooks.map((event) => ({
      id: event.id,
      direction: "inbound" as const,
      operation: "webhook",
      order_id: event.provider_order_id,
      provider_status: event.provider_status,
      outcome: inboundOutcome(event),
      http_status: null,
      duration_ms: null,
      ip_address: event.ip_address,
      error_message: event.processing_error,
      occurred_at: event.created_at.toISOString(),
    })),
    ...calls.map((call) => ({
      id: call.id,
      direction: "outbound" as const,
      operation: call.operation,
      order_id: call.order_id,
      provider_status: null,
      outcome: call.outcome,
      http_status: call.http_status,
      duration_ms: call.duration_ms,
      ip_address: null,
      error_message: call.error_message,
      occurred_at: call.created_at.toISOString(),
    })),
  ].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  return ok(
    {
      logs: rows,
      /*
        Batas baris dipatok di server, bukan diterima dari klien. Halaman ini alat penelusuran,
        bukan penjelajah arsip: yang berguna adalah kejadian terakhir, dan memuat seluruh riwayat
        hanya membuat halamannya lambat tanpa menambah apa pun.
      */
      meta: {
        shown: rows.length,
        limit_per_direction: limit,
        count_by_direction: {
          inbound: rows.filter((row) => row.direction === "inbound").length,
          outbound: rows.filter((row) => row.direction === "outbound").length,
        },
        count_by_outcome: {
          verified: rows.filter((row) => row.outcome === "verified").length,
          pending: rows.filter((row) => row.outcome === "pending").length,
          rejected: rows.filter((row) => row.outcome === "rejected").length,
          unknown_order: rows.filter((row) => row.outcome === "unknown_order").length,
          success: rows.filter((row) => row.outcome === "success").length,
          failed: rows.filter((row) => row.outcome === "failed").length,
        },
        note:
          "Kedua arah dibatasi 50 baris terakhir per arah, karena halaman ini untuk menelusuri " +
          "kejadian terakhir, bukan menjelajahi arsip.",
      },
      provider_health: {
        window_hours: 24,
        by_operation: health.map((row) => ({
          operation: row.operation,
          total: row.total,
          success: row.success,
          failed: row.failed,
          avg_duration_ms: row.avg_duration_ms,
          max_duration_ms: row.max_duration_ms,
          last_call_at: row.last_call_at?.toISOString() ?? null,
          last_failure_at: row.last_failure_at?.toISOString() ?? null,
        })),
      },
    },
    requestId,
  );
});

/*
  Hasil notifikasi yang masuk disimpulkan, bukan dibaca dari kolom, karena tabelnya menyimpan
  fakta mentah: apakah barisnya pernah diproses, dan apakah pemrosesannya gagal.

  Urutan pemeriksaannya penting. Notifikasi dengan nomor pesanan yang tidak dikenal dan sekaligus
  belum diproses harus terbaca sebagai "nomor pesanan tidak dikenal", bukan sekadar "belum
  diproses", karena yang pertama menunjuk pada upaya pemalsuan sedangkan yang kedua menunjuk
  pada job yang tertinggal.
*/
function inboundOutcome(event: {
  payment_attempt_id: string | null;
  processed_at: Date | null;
  processing_error: string | null;
}): "verified" | "pending" | "rejected" | "unknown_order" {
  if (event.processing_error) {
    /*
      Percobaan yang tidak menempel pada pembayaran mana pun berarti nomor pesanannya tidak
      pernah kita buat. Persis inilah yang langsung dicurigai sebagai notifikasi palsu.
    */
    return event.payment_attempt_id === null ? "unknown_order" : "rejected";
  }
  if (event.processed_at) return "verified";
  /*
    Belum diproses bukan berarti ditolak, dan bukan berarti cocok. Keadaannya masih menggantung,
    jadi tidak disimpulkan apa pun.
  */
  return "pending";
}
