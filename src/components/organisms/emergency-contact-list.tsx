"use client";

import { PhoneCallIcon, PlusIcon, PencilSimpleIcon, PowerIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/atoms";
import { DataTable, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge, type Column } from "@/components/molecules";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirmAction, notifyError, notifySuccess } from "@/lib/alert";
import { mutate, useApiQuery } from "@/lib/use-api";
import { useSessionStore } from "@/stores/session-store";

type Category = "security" | "police" | "fire" | "ambulance" | "technician" | "custom";
type Contact = {
  id: string;
  name: string;
  phone: string;
  description: string | null;
  category: Category;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type Response = { contacts: Contact[] };
type FormState = Omit<Contact, "id" | "created_at" | "updated_at">;

const categories: { value: Category; label: string }[] = [
  { value: "security", label: "Keamanan" },
  { value: "police", label: "Polisi" },
  { value: "fire", label: "Pemadam kebakaran" },
  { value: "ambulance", label: "Ambulans" },
  { value: "technician", label: "Teknisi" },
  { value: "custom", label: "Lainnya" },
];

const emptyForm: FormState = {
  name: "",
  phone: "",
  description: "",
  category: "security",
  sort_order: 0,
  is_active: true,
};

function categoryLabel(value: Category) {
  return categories.find((item) => item.value === value)?.label ?? value;
}

export function EmergencyContactList() {
  const query = useApiQuery<Response>("/api/v1/admin/emergency-contacts");
  const permissions = useSessionStore((state) => state.permissions);
  const isSuperAdmin = useSessionStore((state) => state.admin?.is_super_admin ?? false);
  const canManage = isSuperAdmin || permissions.includes("emergency_contact.manage");
  const [dialog, setDialog] = useState<{ contact: Contact | null; form: FormState } | null>(null);

  const rows = query.data?.contacts ?? [];
  const columns: Column<Contact>[] = [
    {
      key: "contact",
      header: "Kontak",
      cell: (row) => (
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-md" aria-hidden="true">
            <PhoneCallIcon weight="regular" className="size-5" />
          </span>
          <div className="min-w-44">
            <div className="font-medium">{row.name}</div>
            <div className="text-muted-foreground text-[13px]">{row.phone}</div>
          </div>
        </div>
      ),
    },
    { key: "category", header: "Kategori", cell: (row) => categoryLabel(row.category) },
    { key: "description", header: "Keterangan", cell: (row) => row.description || <span className="text-muted-foreground">Tidak ada keterangan</span> },
    { key: "order", header: "Urutan", align: "right", cell: (row) => <span className="tabular-nums">{row.sort_order}</span> },
    { key: "status", header: "Status", cell: (row) => <StatusBadge tone={row.is_active ? "success" : "neutral"}>{row.is_active ? "Aktif" : "Nonaktif"}</StatusBadge> },
  ];

  if (canManage) {
    columns.push({
      key: "actions",
      header: "Tindakan",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog({ contact: row, form: { ...row, description: row.description ?? "" } })}>
            <PencilSimpleIcon /> Ubah
          </Button>
          {row.is_active ? (
            <Button variant="ghost" onClick={() => void deactivate(row)}>
              <PowerIcon /> Nonaktifkan
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  async function deactivate(row: Contact) {
    const confirmed = await confirmAction({
      title: "Nonaktifkan nomor ini?",
      text: `${row.name} tidak akan muncul di aplikasi mobile. Data tetap tersimpan untuk audit.`,
      confirmLabel: "Nonaktifkan",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await mutate(`/api/v1/admin/emergency-contacts/${row.id}`, { method: "DELETE" });
      notifySuccess("Nomor dinonaktifkan");
      query.reload();
    } catch (error) {
      notifyError("Nomor gagal dinonaktifkan", error instanceof Error ? error.message : undefined);
    }
  }

  async function save(form: FormState, contact: Contact | null) {
    try {
      const payload = { ...form, description: form.description?.trim() || null, sort_order: Number(form.sort_order) };
      await mutate(contact ? `/api/v1/admin/emergency-contacts/${contact.id}` : "/api/v1/admin/emergency-contacts", {
        method: contact ? "PATCH" : "POST",
        body: payload,
      });
      setDialog(null);
      notifySuccess(contact ? "Nomor diperbarui" : "Nomor ditambahkan");
      query.reload();
    } catch (error) {
      notifyError("Nomor gagal disimpan", error instanceof Error ? error.message : undefined);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Nomor emergency"
        description="Daftar nomor yang muncul saat customer membuka Emergency Call di aplikasi mobile."
        actions={canManage ? <Button onClick={() => setDialog({ contact: null, form: emptyForm })}><PlusIcon /> Tambah nomor</Button> : undefined}
      />

      {query.status === "memuat" ? <LoadingState label="Memuat nomor emergency" /> : null}
      {query.status === "galat" ? <ErrorState title="Nomor emergency gagal dimuat" description={query.error ?? "Server tidak merespons. Coba muat ulang."} onRetry={query.reload} /> : null}
      {query.status === "siap" ? (
        <DataTable
          label="Daftar nomor emergency"
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          emptyState={<EmptyState title="Belum ada nomor emergency" description="Tambahkan nomor pertama agar customer bisa memilih kontak bantuan." action={canManage ? <Button onClick={() => setDialog({ contact: null, form: emptyForm })}>Tambah nomor</Button> : undefined} />}
        />
      ) : null}

      <ContactDialog key={`${dialog ? "open" : "closed"}-${dialog?.contact?.id ?? "new"}`} state={dialog} onClose={() => setDialog(null)} onSave={save} />
    </div>
  );
}

function ContactDialog({ state, onClose, onSave }: { state: { contact: Contact | null; form: FormState } | null; onClose: () => void; onSave: (form: FormState, contact: Contact | null) => Promise<void> }) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const contact = state?.contact ?? null;

  if (state && form !== state.form && !saving) setForm(state.form);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try { await onSave(form, contact); } finally { setSaving(false); }
  }

  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? "Ubah nomor emergency" : "Tambah nomor emergency"}</DialogTitle>
          <DialogDescription>Nomor aktif tampil di halaman Emergency Call aplikasi mobile.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2"><Label htmlFor="emergency-name">Nama kontak</Label><Input id="emergency-name" required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Satpam gedung" /></div>
          <div className="grid gap-2"><Label htmlFor="emergency-phone">Nomor telepon</Label><Input id="emergency-phone" required maxLength={30} inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="081234567890" /></div>
          <div className="grid gap-2"><Label htmlFor="emergency-category">Kategori</Label><select id="emergency-category" className="border-input bg-background focus-visible:ring-ring h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as Category })}>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <div className="grid gap-2"><Label htmlFor="emergency-description">Keterangan <span className="text-muted-foreground font-normal">(opsional)</span></Label><Textarea id="emergency-description" maxLength={500} value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Keamanan gedung" /></div>
          <div className="grid gap-2"><Label htmlFor="emergency-order">Urutan tampil</Label><Input id="emergency-order" required type="number" min={0} max={100000} value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} /></div>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} /> Tampilkan di aplikasi mobile</label>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={saving}>Batal</Button><Button type="submit" disabled={saving}>{saving ? "Menyimpan..." : "Simpan"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
