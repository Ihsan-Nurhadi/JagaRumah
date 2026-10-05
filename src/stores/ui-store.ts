import { create } from "zustand";
import { persist } from "zustand/middleware";

/*
  State tata letak dipakai bersama oleh shell dan tombolnya.
  Collapse disimpan supaya pilihan admin bertahan antar sesi.
*/
type ShellState = {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
};

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      mobileNavOpen: false,
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
    }),
    {
      name: "nayaka.shell",
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed }),
    },
  ),
);
