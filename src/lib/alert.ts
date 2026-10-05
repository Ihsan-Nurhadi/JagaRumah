import Swal from "sweetalert2";

/*
  SweetAlert2 bekerja imperatif dan merender di luar pohon React,
  jadi dipakai sebagai service, bukan komponen. Ia tetap mewarisi token warna
  karena variabel CSS ada di :root dan .dark pada elemen html.
*/

const toast = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 4000,
  timerProgressBar: true,
});

export function notifySuccess(title: string, text?: string) {
  void toast.fire({ icon: "success", title, text });
}

export function notifyError(title: string, text?: string) {
  // Galat tidak ditutup otomatis supaya sempat dibaca.
  void toast.fire({ icon: "error", title, text, timer: undefined });
}

export function notifyInfo(title: string, text?: string) {
  void toast.fire({ icon: "info", title, text });
}

type ConfirmOptions = {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export async function confirmAction({
  title,
  text,
  confirmLabel,
  cancelLabel = "Batal",
  destructive = false,
}: ConfirmOptions): Promise<boolean> {
  const result = await Swal.fire({
    title,
    text,
    icon: destructive ? "warning" : "question",
    showCancelButton: true,
    confirmButtonText: confirmLabel,
    cancelButtonText: cancelLabel,
    reverseButtons: true,
    focusCancel: destructive,
    customClass: {
      confirmButton: destructive ? "swal-confirm-destructive" : "swal-confirm",
      cancelButton: "swal-cancel",
    },
  });

  return result.isConfirmed;
}
