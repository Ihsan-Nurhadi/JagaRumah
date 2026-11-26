import net from "node:net";
import tls from "node:tls";

const SMTP_TIMEOUT_MS = 15000;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} belum diisi`);
  return value;
}

function readSmtpResponse(socket: net.Socket | tls.TLSSocket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("Koneksi ke server SMTP timeout."));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Koneksi ke server SMTP terputus sebelum respons selesai."));
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      // Baris terakhir belum lengkap jika buffer tidak diakhiri newline
      const completeCount = buffer.endsWith("\n") ? lines.length - 1 : lines.length - 2;
      for (let i = completeCount; i >= 0; i--) {
        const line = lines[i];
        const match = /^(\d{3}) /.exec(line);
        if (match) {
          cleanup();
          resolve({ code: Number(match[1]), text: buffer.trim() });
          return;
        }
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);
  });
}

async function smtpCommand(socket: net.Socket | tls.TLSSocket, command: string): Promise<string> {
  const wait = readSmtpResponse(socket);
  socket.write(`${command}\r\n`);
  const res = await wait;
  if (res.code >= 400) {
    throw new Error(`SMTP error ${res.code}: ${res.text}`);
  }
  return res.text;
}

export async function sendPasswordResetEmail(input: { to: string; name: string; code: string }): Promise<void> {
  const host = required("MAILTRAP_SMTP_HOST");
  const port = Number(process.env.MAILTRAP_SMTP_PORT ?? "2525");
  const username = required("MAILTRAP_SMTP_USERNAME");
  const password = required("MAILTRAP_SMTP_PASSWORD");
  const from = required("MAILTRAP_FROM_EMAIL");
  const fromName = process.env.MAILTRAP_FROM_NAME?.trim() || "Nayaka";

  let socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    if (port === 465) {
      const secure = tls.connect({ host, port, rejectUnauthorized: true });
      secure.setTimeout(SMTP_TIMEOUT_MS);
      secure.once("secureConnect", () => {
        secure.off("error", onError);
        resolve(secure);
      });
      secure.once("error", onError);
      secure.once("timeout", () => {
        secure.destroy();
        reject(new Error(`Koneksi TLS ke ${host}:${port} timeout.`));
      });
    } else {
      const plain = net.connect({ host, port });
      plain.setTimeout(SMTP_TIMEOUT_MS);
      plain.once("connect", () => {
        plain.off("error", onError);
        resolve(plain);
      });
      plain.once("error", onError);
      plain.once("timeout", () => {
        plain.destroy();
        reject(new Error(`Koneksi ke ${host}:${port} timeout.`));
      });
    }
  });

  try {
    // Tunggu banner 220 dari server SMTP sebelum mengirim EHLO
    const greeting = await readSmtpResponse(socket);
    if (greeting.code >= 400) {
      throw new Error(`SMTP greeting error ${greeting.code}: ${greeting.text}`);
    }

    await smtpCommand(socket, "EHLO nayaka");
    if (port !== 465) {
      await smtpCommand(socket, "STARTTLS");
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket, host, rejectUnauthorized: true }, () => resolve(upgraded));
        upgraded.setTimeout(SMTP_TIMEOUT_MS);
        upgraded.once("error", reject);
      });
      socket = secure;
      await smtpCommand(socket, "EHLO nayaka");
    }

    await smtpCommand(socket, "AUTH LOGIN");
    await smtpCommand(socket, Buffer.from(username).toString("base64"));
    await smtpCommand(socket, Buffer.from(password).toString("base64"));
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${input.to}>`);
    const body = [
      `From: ${fromName} <${from}>`,
      `To: ${input.to}`,
      "Subject: Kode reset password Nayaka",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Halo ${input.name},`,
      "",
      `Kode reset password: ${input.code}`,
      "Kode berlaku 15 menit.",
      "Jika bukan Anda, abaikan email ini.",
      "",
    ].join("\r\n");
    await smtpCommand(socket, "DATA");
    await smtpCommand(socket, `${body}\r\n.`);
    await smtpCommand(socket, "QUIT");
  } finally {
    socket.destroy();
  }
}
