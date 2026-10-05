import { SignJWT, errors, jwtVerify } from "jose";
import { ADMIN_ACCESS_TTL_SECONDS, jwtAdminAccessSecret } from "./config";
import { AppError } from "./errors";

/*
  Access token admin.

  Token ini hanya membawa identitas dan nomor sesi. Permission tidak dimasukkan, karena
  permission yang tertanam di token tetap berlaku sampai token kedaluwarsa meski role-nya
  sudah dicabut. Server selalu membaca permission terbaru dari database.
*/

export type AdminAccessClaims = {
  adminUserId: string;
  sessionId: string;
};

const TYPE = "admin_access";
const ALGORITHM = "HS256";

function key(): Uint8Array {
  return new TextEncoder().encode(jwtAdminAccessSecret());
}

export async function signAdminAccessToken(claims: AdminAccessClaims): Promise<string> {
  return new SignJWT({ typ: TYPE, sid: claims.sessionId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.adminUserId)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_ACCESS_TTL_SECONDS}s`)
    .sign(key());
}

/*
  Token yang gagal diverifikasi selalu menjadi `401`, dan dibedakan antara kedaluwarsa dan
  tidak sah. Bedanya penting bagi klien: yang kedaluwarsa cukup di-refresh, sedangkan yang
  tidak sah harus login ulang.

  Algoritma dikunci ke HS256. Tanpa kunci ini, token yang mengeklaim `alg: none` bisa lolos di
  implementasi yang ceroboh.
*/
export async function verifyAdminAccessToken(token: string): Promise<AdminAccessClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, key(), { algorithms: [ALGORITHM] });
    payload = result.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new AppError({
        code: "TOKEN_EXPIRED",
        message: "Sesi Anda sudah berakhir. Muat ulang halaman lalu masuk kembali.",
      });
    }
    throw new AppError({
      code: "TOKEN_REVOKED",
      message: "Sesi tidak dikenali. Masuk kembali untuk melanjutkan.",
    });
  }

  const sub = payload.sub;
  const sid = payload.sid;
  if (payload.typ !== TYPE || typeof sub !== "string" || typeof sid !== "string") {
    throw new AppError({
      code: "TOKEN_REVOKED",
      message: "Sesi tidak dikenali. Masuk kembali untuk melanjutkan.",
    });
  }

  return { adminUserId: sub, sessionId: sid };
}
