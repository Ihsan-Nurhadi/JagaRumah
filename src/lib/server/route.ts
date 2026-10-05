import { AppError, errorResponse, toAppError } from "./errors";

/*
  Pembungkus route handler.

  Setiap route admin memakai bentuk yang sama: satu request_id yang ikut ke response dan ke
  log, envelope sukses dari `ok()` atau `listed()`, dan kegagalan yang selalu berbentuk
  `{ error }`.

  Penanganan galat ditaruh di sini, bukan diulang di tiap berkas, karena pengulangan itulah
  yang biasanya membuat satu endpoint lupa menutup kebocoran pesan galat mentah ke klien.

  Argumen ketiga adalah context dari Next.js, yang pada rute dinamis memuat `params` berupa
  Promise. Context diteruskan apa adanya supaya handler yang tidak memakainya tidak perlu
  menuliskannya, dan handler rute dinamis tetap bisa membacanya.
*/
export function routeHandler(
  context: string,
  handler: (
    request: Request,
    requestId: string,
    // Tipe longgar karena Next.js membangkitkan tipe tepat per rute; yang dipakai handler
    // hanyalah `params`, dan itu diperiksa di tempat pemakaiannya.
    routeContext: unknown,
  ) => Promise<Response>,
): (request: Request, routeContext?: unknown) => Promise<Response> {
  return async (request: Request, routeContext?: unknown): Promise<Response> => {
    const requestId = request.headers.get("x-request-id")?.slice(0, 200) || crypto.randomUUID();

    try {
      return await handler(request, requestId, routeContext);
    } catch (error) {
      const appError: AppError = toAppError(error, context);
      return errorResponse(appError, requestId);
    }
  };
}
