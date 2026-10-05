import { create } from "zustand";

import { ApiError, http } from "@/lib/http";

/*
  State sesi admin.

  Yang disimpan di sini hanya identitas dan daftar permission. Token akses tidak pernah masuk
  ke state, karena ia berada di cookie HttpOnly dan memang tidak bisa dibaca JavaScript. Yang
  bisa dibaca hanyalah token CSRF, dan itu dibaca dari cookie saat dibutuhkan.

  Permission di sini bukan pengaman. Fungsinya menyembunyikan tombol yang tidak boleh dipakai,
  sedangkan penolakan sebenarnya dilakukan server pada setiap endpoint.
*/

export type AdminProfile = {
  id: string;
  username: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  is_super_admin: boolean;
};

type SessionPayload = {
  admin: AdminProfile;
  permissions: string[];
  csrf_token?: string;
  session?: { session_id: string };
};

export type SessionStatus = "memuat" | "masuk" | "tamu";

type SessionState = {
  status: SessionStatus;
  admin: AdminProfile | null;
  permissions: string[];
  load: () => Promise<void>;
  ensureReady: () => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
};

/*
  Token CSRF dibaca dari cookie, bukan dari state. Nilai di cookie itulah yang dibandingkan
  server, jadi state yang tertinggal setelah halaman dimuat ulang akan mengirim nilai basi.
*/
function csrfFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)admin_csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/*
  Token yang belum ada diambil lebih dulu. Tanpa langkah ini, login pertama setelah cookie
  dibersihkan selalu gagal dengan pesan yang membingungkan pengguna.
*/
export async function ensureCsrfToken(): Promise<string> {
  const existing = csrfFromCookie();
  if (existing) return existing;

  const response = await http.get<{ data: { csrf_token: string } }>("/admin/auth/csrf");
  return response.data.data.csrf_token;
}

export function csrfHeader(token: string): Record<string, string> {
  return { "X-CSRF-Token": token };
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: "memuat",
  admin: null,
  permissions: [],

  load: async () => {
    try {
      const response = await http.get<{ data: SessionPayload }>("/admin/me");
      applySession(set, response.data.data);
      return;
    } catch (error) {
      /*
        Access token yang kedaluwarsa dicoba diperpanjang sekali sebelum dianggap tamu.
        Langkah inilah yang membuat admin tidak perlu mengetik kata sandi setiap 15 menit.
      */
      if (error instanceof ApiError && error.status === 401) {
        const refreshed = await tryRefresh();
        if (refreshed) {
          applySession(set, refreshed);
          return;
        }
      }
      set({ status: "tamu", admin: null, permissions: [] });
    }
  },

  /*
    Dipanggil sebelum memuat data halaman. Sesi hanya diperiksa sekali per muat halaman,
    supaya perpindahan antar halaman tidak memicu pemeriksaan berulang.
  */
  ensureReady: async () => {
    if (get().status !== "memuat") return;
    await get().load();
  },

  signIn: async (input) => {
    const token = await ensureCsrfToken();
    const response = await http.post<{ data: SessionPayload }>("/admin/auth/login", input, {
      headers: csrfHeader(token),
    });
    applySession(set, response.data.data);
  },

  signOut: async () => {
    const token = csrfFromCookie();
    try {
      if (token) {
        await http.post("/admin/auth/logout", undefined, { headers: csrfHeader(token) });
      }
    } finally {
      /*
        State dibersihkan meski permintaan logout gagal. Membiarkan antarmuka tetap terlihat
        masuk setelah pengguna menekan keluar justru lebih berbahaya daripada sesi yang masih
        hidup di server, karena pengguna akan mengira dirinya sudah keluar.
      */
      set({ status: "tamu", admin: null, permissions: [] });
    }
  },

  hasPermission: (permission) => {
    const { permissions, admin } = get();
    if (admin?.is_super_admin) return true;
    return permissions.includes(permission);
  },
}));

function applySession(
  set: (partial: Partial<SessionState>) => void,
  payload: SessionPayload,
): void {
  set({
    status: "masuk",
    admin: payload.admin,
    permissions: payload.permissions ?? [],
  });
}

async function tryRefresh(): Promise<SessionPayload | null> {
  const token = csrfFromCookie();
  if (!token) return null;

  try {
    const response = await http.post<{ data: SessionPayload }>(
      "/admin/auth/refresh",
      undefined,
      { headers: csrfHeader(token) },
    );
    return response.data.data;
  } catch {
    return null;
  }
}
