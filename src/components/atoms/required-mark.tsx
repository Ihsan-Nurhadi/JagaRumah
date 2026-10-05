/*
  Penanda wajib diisi. Tanda bintang sendiri tidak terbaca pembaca layar,
  jadi maknanya dinyatakan dalam teks yang hanya terlihat oleh pembaca layar.
*/
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="text-danger ml-0.5">
        *
      </span>
      <span className="sr-only">wajib diisi</span>
    </>
  );
}
