import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/*
  Menandai bahwa komponen sudah berjalan di klien.
  Dipakai untuk nilai yang hanya diketahui di klien, seperti tema,
  tanpa memicu render tambahan lewat efek.
*/
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
