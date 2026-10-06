/*
  Endpoint daftar perangkat.

  Filter, urutan, dan paginasi ditangani di lapisan ini. Yang penting untuk halaman daftar:
  ringkasan jumlah per status dibaca dengan filter yang sama seperti tabelnya, sehingga angka di
  kartu ringkasan tidak pernah bertentangan dengan isi tabel di bawahnya.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, withTransaction } from "@/lib/server/db";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { claimLabel, registerDevice } from "@/lib/server/devices";
import { parseJson } from "@/lib/server/parse";
import { createDeviceSchema } from "@/lib/schemas/admin-device";
import { deviceFilterConditions, deviceSummary, type DeviceListRow } from "@/lib/server/devices";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { AppError } from "@/lib/server/errors";

/*
  Allowlist sortir. Kolom di luar daftar ini tidak bisa dipakai mengurutkan, dan itu sekaligus
  menutup jalan menyisipkan nama kolom sembarang lewat parameter.
*/
const SORT: SortAllowlist = {
  created_at: { column: "d.created_at", defaultDirection: "desc" },
  device_uid: { column: "d.device_uid", defaultDirection: "asc" },
  serial_number: { column: "d.serial_number", defaultDirection: "asc" },
  status: { column: "d.status", defaultDirection: "asc" },
  claimed_at: { column: "d.claimed_at", defaultDirection: "desc" },
};

const DEVICE_STATUSES = ["in_stock", "claimed", "suspended", "retired", "deleted"];

export const GET = routeHandler("admin.devices.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const status = url.searchParams.get("status");
  if (status && !DEVICE_STATUSES.includes(status)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Status "${status}" tidak dikenal. Pilihan yang tersedia: ${DEVICE_STATUSES.join(", ")}.`,
      details: { status, allowed: DEVICE_STATUSES },
    });
  }

  const filter = {
    status: status ?? undefined,
    model: url.searchParams.get("model") ?? undefined,
    batchNumber: url.searchParams.get("batch_number") ?? undefined,
    customerId: url.searchParams.get("customer_id") ?? undefined,
    q: url.searchParams.get("q")?.trim() || undefined,
  };

  const params: unknown[] = [];
  /*
    Filter dijalankan sebelum keyset, dan urutan push parameternya harus sama dengan urutan
    kemunculan $n di dalam SQL. Karena itu keduanya disusun berurutan di sini, bukan dirakit
    terpisah lalu digabung.
  */
  const filterSql = deviceFilterConditions(filter, params);
  const keysetSql = keysetCondition(page, params);

  const sql = `
    SELECT d.id,
           d.created_at::text AS cursor_value,
           d.device_uid,
           d.serial_number,
           d.name,
           d.model,
           d.batch_number,
           d.status,
           d.claim_method,
           d.claimed_at,
           d.customer_id,
           c.full_name AS customer_name,
           d.created_at
    FROM devices d
    LEFT JOIN customers c ON c.id = d.customer_id
    WHERE d.status <> 'deleted'
          ${filterSql}
          ${keysetSql}
    ${orderBy(page)}
    LIMIT ${page.limit + 1}
  `;

  const rows = await query<DeviceListRow>(sql, params);
  const { items, pagination } = buildPage(rows, page);

  /*
    Ringkasan dihitung tanpa keyset, karena yang diminta adalah jumlah seluruh hasil filter,
    bukan jumlah pada halaman ini. Tanpa pemisahan ini, kartu ringkasan akan berubah setiap kali
    pengguna menekan "berikutnya" dan angkanya jadi menyesatkan.
  */
  const summary = await deviceSummary();

  const body = {
    devices: items.map((row) => ({
      id: row.id,
      device_uid: row.device_uid,
      serial_number: row.serial_number,
      name: row.name,
      model: row.model,
      batch_number: row.batch_number,
      status: row.status,
      claim_method: row.claim_method,
      claimed_at: row.claimed_at?.toISOString() ?? null,
      customer: row.customer_id
        ? { id: row.customer_id, full_name: row.customer_name }
        : null,
      created_at: row.created_at.toISOString(),
    })),
    summary: {
      total: summary?.total ?? 0,
      in_stock: summary?.in_stock ?? 0,
      claimed: summary?.claimed ?? 0,
      suspended: summary?.suspended ?? 0,
      retired: summary?.retired ?? 0,
      /*
        Perangkat di gudang yang kode claimnya belum terpakai. Angka ini yang menjawab
        "berapa yang siap dijual", dan itu pertanyaan pertama saat menyiapkan pengiriman.
      */
      unclaimed_with_active_code: summary?.unclaimed_with_active_code ?? 0,
    },
    filters: {
      status: status ?? null,
      model: filter.model ?? null,
      batch_number: filter.batchNumber ?? null,
      customer_id: filter.customerId ?? null,
      q: filter.q ?? null,
    },
  };

  return listed(body, pagination, requestId);
});

/*
  Pendaftaran perangkat baru.

  Response memuat kode claim dalam bentuk asli, dan ini satu-satunya kesempatan kode itu terlihat.
  Yang tersimpan di database hanya hash-nya, jadi kode yang tidak sempat dicetak atau disalin
  tidak bisa ditampilkan lagi. Kode yang hilang hanya bisa diganti dengan merotasi kode baru.
*/
export const POST = routeHandler("admin.devices.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.create");
  await requireCsrf(request);

  const input = await parseJson(request, createDeviceSchema);

  const result = await withTransaction(async (client) => {
    const registered = await registerDevice(client, {
      serialNumber: input.serial_number,
      name: input.name ?? null,
      model: input.model ?? null,
      hardwareRevision: input.hardware_revision ?? null,
      batchNumber: input.batch_number ?? null,
      macAddress: input.mac_address ?? null,
      imei: input.imei ?? null,
      /*
        Tanggal garansi dikirim sebagai string ISO. Kolomnya timestamptz dan PostgreSQL menerima
        string ISO apa adanya, jadi konversinya tidak perlu diulang di kode.
      */
      warrantyStartAt: input.warranty_start_at ? new Date(input.warranty_start_at) : null,
      adminUserId: admin.identity.id,
      streamUrl: input.stream_url ?? null,
    });

    /*
      Jejak audit ditulis di dalam transaksi yang sama. Kalau transaksinya dibatalkan, catatan
      perangkat yang tidak pernah ada tidak boleh tertinggal.
    */
    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "device.create",
      entityType: "device",
      entityId: registered.deviceId,
      newData: {
        device_uid: registered.deviceUid,
        serial_number: input.serial_number,
        model: input.model ?? null,
        batch_number: input.batch_number ?? null,
      },
    });

    return registered;
  });

  return created(
    {
      device: {
        id: result.deviceId,
        device_uid: result.deviceUid,
        serial_number: input.serial_number,
        model: input.model ?? null,
        status: "in_stock",
      },
      /*
        Label claim, ditampilkan sekali. Bentuk terformat ikut dikirim supaya operator bisa
        membacakannya lewat telepon tanpa salah membedakan angka dan huruf.
      */
      claim_label: {
        ...claimLabel(result.claimToken),
        shown_once: true,
      },
    },
    requestId,
  );
});
